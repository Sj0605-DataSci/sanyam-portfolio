/// <reference lib="webworker" />
import { pipeline, AutoTokenizer, AutoModelForCausalLM, TextStreamer } from '@huggingface/transformers'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'

interface KBChunk {
  source: string
  section: string
  text: string
}

const TOP_K = 4
const SIMILARITY_THRESHOLD = 0.15
const REFUSAL =
  "I can only answer questions about Sanyam — try asking about his work, projects, or background."

// Broad openers ("who is he", "tell me about him") don't have enough
// distinguishing keywords for retrieval to find a good, focused chunk set —
// the query collapses to just "sanyam" after stopword filtering, so
// similarity search matches almost arbitrarily. Route these to a
// hand-written overview instead of trusting retrieval + a 230M model to
// synthesize a good summary from scratch.
const BROAD_QUESTION_PATTERNS = [
  /\b(who is|what do you know about|tell me about|give me an? overview|introduce)\b/i,
  /\bwhat (is|about) sanyam\b/i,
]

const OVERVIEW =
  "Sanyam is an AI-ML Engineer, Researcher, and Backend Engineer based in Delhi, India. He's currently a Research Assistant / Project Scientist at IIT Delhi DAIR, working on world models and action-guided diffusion models, and he co-founded Noteweave and Discoverminds.ai. Ask me about his work, projects, education, or background for more."

function isBroadQuestion(question: string): boolean {
  const trimmed = question.trim()
  if (trimmed.split(/\s+/).length <= 4) return true
  return BROAD_QUESTION_PATTERNS.some((re) => re.test(trimmed))
}

const ANSWER_SYSTEM_PROMPT = `You are Sanyam Jain's portfolio assistant. The excerpts below are true, verified facts about Sanyam — treat them as your own knowledge, not as something someone "provided" to you. Answer the question directly and confidently using them, in 1-3 short spoken sentences, conversational, no markdown, no lists.

Never say things like "I don't have personal knowledge", "based on the information provided", "I can share general information", or any other hedge about where the facts came from — just state the facts plainly, as if you already knew them.

Never invent, guess, or add anything not stated in the excerpts. If the excerpts truly don't contain the answer, simply say you're not sure and suggest checking the journey or projects page — nothing more.`

const ASR_PROMPT =
  'Sanyam Jain, IIT Delhi, DAIR, Noteweave, Discoverminds, Manipal, arXiv, Kokoro, LFM2.'

type MainToWorker =
  | { type: 'load' }
  | { type: 'transcribe'; audio: Float32Array }
  | { type: 'ask'; question: string }
  | { type: 'stop' }

type WorkerToMain =
  | { type: 'load-progress'; label: string; progress: number }
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply-done'; text: string }
  | { type: 'audio-chunk'; buffer: ArrayBuffer; sampleRate: number; text: string }
  | { type: 'speaking-done' }
  | { type: 'error'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer)
}

let transcriber: any = null
let embedder: any = null
let tokenizer: any = null
let llm: any = null
let tts: any = null
let ready = false
let stopRequested = false

let kb: KBChunk[] = []
let kbEmbeddings: Float32Array[] = []

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function embed(text: string): Promise<Float32Array> {
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return output.data as Float32Array
}

// ── BM25 keyword scoring over the knowledge-base chunks ────────────────────
// Pure embedding similarity confuses topically-close-but-distinct chunks
// (e.g. "current research" vs "job search" both mention "startups"). Keyword
// overlap on distinguishing words ("now", "before", proper nouns) fixes that
// where embeddings alone miss it. A full BM25 library is unnecessary for a
// corpus this small, so this is a direct implementation of the formula.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'what', 'who', 'where', 'when',
  'why', 'how', 'his', 'he', 'him', 'does', 'do', 'did', 'about', 'in', 'at',
  'to', 'of', 'and', 'or', 'for', 'on', 'with', 'it', 'that', 'this', 'be',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

const BM25_K1 = 1.5
const BM25_B = 0.75

let bm25Docs: string[][] = []
let bm25DocFreq: Map<string, number> = new Map()
let bm25AvgDocLen = 0

function buildBM25Index(): void {
  bm25Docs = kb.map((c) => tokenize(`${c.section} ${c.text}`))
  bm25AvgDocLen = bm25Docs.reduce((sum, d) => sum + d.length, 0) / bm25Docs.length
  bm25DocFreq = new Map()
  for (const doc of bm25Docs) {
    for (const term of new Set(doc)) {
      bm25DocFreq.set(term, (bm25DocFreq.get(term) ?? 0) + 1)
    }
  }
}

function bm25Score(queryTerms: string[], docIdx: number): number {
  const doc = bm25Docs[docIdx]
  const docLen = doc.length
  const termFreq = new Map<string, number>()
  for (const t of doc) termFreq.set(t, (termFreq.get(t) ?? 0) + 1)

  let score = 0
  const N = bm25Docs.length
  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0
    if (tf === 0) continue
    const df = bm25DocFreq.get(term) ?? 0
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    const numerator = tf * (BM25_K1 + 1)
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / bm25AvgDocLen))
    score += idf * (numerator / denominator)
  }
  return score
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 1e-9)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  return values.map((v) => (v - min) / range)
}

/** Hybrid retrieval: combine BM25 keyword score + embedding cosine similarity. */
async function retrieveTopChunks(question: string): Promise<{ chunks: KBChunk[]; topScore: number }> {
  const queryEmbedding = await embed(question)
  const queryTerms = tokenize(question)

  const cosineScores = kbEmbeddings.map((e) => cosineSimilarity(queryEmbedding, e))
  const bm25Scores = kb.map((_, i) => bm25Score(queryTerms, i))

  const normCosine = normalize(cosineScores)
  const normBm25 = normalize(bm25Scores)
  const hybrid = kb.map((_, i) => 0.6 * normCosine[i] + 0.4 * normBm25[i])

  const ranked = hybrid
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)

  return {
    chunks: ranked.map((r) => kb[r.i]),
    topScore: Math.max(...cosineScores),
  }
}

async function loadModels(): Promise<void> {
  const weights = { asr: 0, embed: 0, llm: 0, tts: 0 }
  const report = (key: keyof typeof weights, pct: number, label: string): void => {
    weights[key] = pct
    const total = (weights.asr + weights.embed + weights.llm + weights.tts) / 4
    post({ type: 'load-progress', label, progress: total })
  }
  const progressCb = (key: keyof typeof weights, label: string) => (data: any) => {
    if (typeof data?.progress === 'number') report(key, data.progress, label)
  }

  try {
    const kbRes = await fetch('/kb.json')
    kb = await kbRes.json()

    transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
      device: 'webgpu',
      progress_callback: progressCb('asr', 'downloading speech model…'),
    })

    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      progress_callback: progressCb('embed', 'downloading fact-lookup model…'),
    })
    kbEmbeddings = await Promise.all(kb.map((c) => embed(`${c.section}. ${c.text}`)))
    buildBM25Index()

    tokenizer = await AutoTokenizer.from_pretrained('LiquidAI/LFM2.5-230M-ONNX', {
      progress_callback: progressCb('llm', 'downloading language model…'),
    })
    llm = await AutoModelForCausalLM.from_pretrained('LiquidAI/LFM2.5-230M-ONNX', {
      device: 'webgpu',
      dtype: 'q4',
      progress_callback: progressCb('llm', 'downloading language model…'),
    })

    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: progressCb('tts', 'downloading voice model…'),
    })

    ready = true
    post({ type: 'ready' })
  } catch (err) {
    console.error('voice worker: failed to load models', err)
    post({ type: 'load-error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function transcribe(audio: Float32Array): Promise<void> {
  const result = await transcriber(audio, { language: null, prompt: ASR_PROMPT })
  const text: string = Array.isArray(result) ? result[0]?.text ?? '' : result.text ?? ''
  post({ type: 'transcript', text: text.trim() })
}

async function speakDirect(text: string): Promise<void> {
  const audio = await tts.generate(text, { voice: 'af_heart' })
  const buf = audio.audio.buffer.slice(
    audio.audio.byteOffset,
    audio.audio.byteOffset + audio.audio.byteLength
  )
  post({ type: 'audio-chunk', buffer: buf, sampleRate: audio.sampling_rate, text }, [buf])
}

async function ask(question: string): Promise<void> {
  stopRequested = false

  if (isBroadQuestion(question)) {
    await speakDirect(OVERVIEW)
    post({ type: 'reply-done', text: OVERVIEW })
    post({ type: 'speaking-done' })
    return
  }

  const { chunks, topScore } = await retrieveTopChunks(question)

  if (topScore < SIMILARITY_THRESHOLD) {
    await speakDirect(REFUSAL)
    post({ type: 'reply-done', text: REFUSAL })
    post({ type: 'speaking-done' })
    return
  }

  if (stopRequested) {
    post({ type: 'speaking-done' })
    return
  }

  const context = chunks.map((c) => `[${c.section}] ${c.text}`).join('\n')

  // LFM2.5's official chat_template.jinja uses a {% generation %} tag that
  // @huggingface/jinja (the JS Jinja port used by apply_chat_template) can't
  // parse yet. The underlying format is plain ChatML, so build it by hand.
  const prompt =
    '<|startoftext|><|im_start|>system\n' +
    ANSWER_SYSTEM_PROMPT +
    '<|im_end|>\n<|im_start|>user\n' +
    `Excerpts:\n${context}\n\nQuestion: ${question}` +
    '<|im_end|>\n<|im_start|>assistant\n'

  const inputs = tokenizer(prompt, { return_tensors: 'pt' })

  // Feed the LLM's streamed tokens straight into Kokoro's text splitter, so
  // audio for the first sentence starts synthesizing while the LLM is still
  // generating the rest — no waiting for the full reply before any sound.
  const splitter = new TextSplitterStream()
  const audioStream = tts.stream(splitter, { voice: 'af_heart' })

  let generated = ''
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (stopRequested) return
      generated += text
      splitter.push(text)
    },
  })

  const generation = llm
    .generate({ ...inputs, max_new_tokens: 150, do_sample: true, temperature: 0.4, streamer })
    .then(() => {
      splitter.close()
    })

  // Text for each sentence is revealed on the main thread only once its
  // matching audio chunk starts playing, so the transcript and the voice
  // stay in sync instead of the text racing ahead of what's being spoken.
  const consumeAudio = (async () => {
    for await (const { text, audio } of audioStream) {
      if (stopRequested) break
      const samples = audio.audio
      const buf = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
      post({ type: 'audio-chunk', buffer: buf, sampleRate: audio.sampling_rate, text }, [buf])
    }
  })()

  await Promise.all([generation, consumeAudio])

  const finalText = generated.trim() || REFUSAL
  post({ type: 'reply-done', text: finalText })
  post({ type: 'speaking-done' })
}

ctx.addEventListener('message', (e: MessageEvent<MainToWorker>) => {
  const msg = e.data
  if (msg.type === 'stop') {
    stopRequested = true
    return
  }
  void (async () => {
    try {
      if (msg.type === 'load') {
        await loadModels()
      } else if (msg.type === 'transcribe') {
        if (!ready) return
        await transcribe(msg.audio)
      } else if (msg.type === 'ask') {
        if (!ready) return
        await ask(msg.question)
      }
    } catch (err) {
      console.error('voice worker: error handling message', msg.type, err)
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })()
})
