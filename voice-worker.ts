/// <reference lib="webworker" />
import { pipeline, AutoTokenizer, AutoModelForCausalLM, TextStreamer } from '@huggingface/transformers'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'

const SYSTEM_PROMPT = `You are a voice assistant on Sanyam Jain's portfolio website. Only state facts listed below — never invent, guess, combine, or add details that are not explicitly written here. Answer in 1-2 short spoken sentences, conversational, no markdown, no lists. If the answer isn't in the facts below, say you're not sure and suggest checking the journey or projects page.

Q: What does Sanyam do?
A: Sanyam is an AI-ML Engineer, Researcher, and Backend Engineer based in Delhi, India.

Q: What is Sanyam working on right now?
A: Sanyam is a Research Assistant / Project Scientist at IIT Delhi DAIR, advised by Dr Parag Singla and Dr Rohan Paul. His research is on text2game pipelines, world models, and action-guided diffusion models.

Q: What kind of jobs is Sanyam looking for?
A: Sanyam wants to work at startups in frontier and deep tech, like robotics, or companies building their own models such as Sarvam or Smallest.

Q: What has Sanyam built / founded?
A: Sanyam co-founded Noteweave, a VSCode plugin that acts as an auto-scientist — it searches arXiv, bioRxiv, PubMed, and OpenReview, critiques research ideas like an ICLR reviewer, and hands a plan to coding agents. He also built Discoverminds.ai, an open-source AI-powered LinkedIn network search agent.

Q: Where has Sanyam worked before?
A: Sanyam previously worked as ML Engineer 1 at Thena.ai, ML Engineer R&D at Figr Design, ML Research Intern at Writesonic (YC S21), UG Research Associate at IIIT Delhi, SWE Intern at Nokia, Data Science Intern at EY, and ML Contributor at Unify (YC W23).

Q: What is Sanyam's education?
A: Sanyam has a Dual Diploma in Data Science & Programming (BS) from IIT Madras and a B.Tech in Computer Science & Engineering from Manipal University Jaipur.

Q: Tell me something personal about Sanyam.
A: Sanyam grew up in a Baniya family that built a D2C computer hardware business over 30 years. He plays chess, has played flute and tabla, and is into the latest AI research and anime.

Q: How can I contact Sanyam?
A: You can email him at sanyam0605@gmail.com, or find him on LinkedIn as sanyamjain2002 and GitHub as Sj0605-DataSci.`

const ASR_PROMPT =
  'Sanyam Jain, IIT Delhi, DAIR, Noteweave, Discoverminds, Manipal, arXiv, Kokoro, LFM2.'

type MainToWorker =
  | { type: 'load' }
  | { type: 'transcribe'; audio: Float32Array }
  | { type: 'ask'; question: string }

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
let tokenizer: any = null
let llm: any = null
let tts: any = null
let ready = false

async function loadModels(): Promise<void> {
  const weights = { asr: 0, llm: 0, tts: 0 }
  const report = (key: keyof typeof weights, pct: number, label: string): void => {
    weights[key] = pct
    const total = (weights.asr + weights.llm + weights.tts) / 3
    post({ type: 'load-progress', label, progress: total })
  }
  const progressCb = (key: keyof typeof weights, label: string) => (data: any) => {
    if (typeof data?.progress === 'number') report(key, data.progress, label)
  }

  try {
    transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
      device: 'webgpu',
      progress_callback: progressCb('asr', 'downloading speech model…'),
    })

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

async function ask(question: string): Promise<void> {
  // LFM2.5's official chat_template.jinja uses a {% generation %} tag that
  // @huggingface/jinja (the JS Jinja port used by apply_chat_template) can't
  // parse yet. The underlying format is plain ChatML, so build it by hand.
  const prompt =
    '<|startoftext|><|im_start|>system\n' +
    SYSTEM_PROMPT +
    '<|im_end|>\n<|im_start|>user\n' +
    question +
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
      generated += text
      splitter.push(text)
    },
  })

  const generation = llm
    .generate({ ...inputs, max_new_tokens: 150, do_sample: false, streamer })
    .then(() => {
      splitter.close()
    })

  // Text for each sentence is revealed on the main thread only once its
  // matching audio chunk starts playing, so the transcript and the voice
  // stay in sync instead of the text racing ahead of what's being spoken.
  const consumeAudio = (async () => {
    for await (const { text, audio } of audioStream) {
      const samples = audio.audio
      const buf = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
      post({ type: 'audio-chunk', buffer: buf, sampleRate: audio.sampling_rate, text }, [buf])
    }
  })()

  await Promise.all([generation, consumeAudio])

  const finalText = generated.trim() || "i'm not sure — check the journey or projects page for more."
  post({ type: 'reply-done', text: finalText })
  post({ type: 'speaking-done' })
}

ctx.addEventListener('message', (e: MessageEvent<MainToWorker>) => {
  const msg = e.data
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
