import { pipeline, AutoTokenizer, AutoModelForCausalLM, TextStreamer, env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'

// Serve the ONNX Runtime WASM binaries (~40MB) from a CDN instead of bundling
// them into this site's own deploy — they're only needed as a fallback path.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/'
}

const SYSTEM_PROMPT = `You are a voice assistant on Sanyam Jain's portfolio website. Answer visitor questions about Sanyam in clear, natural, spoken English — 1-3 short sentences, conversational, no markdown, no lists. If asked something you don't know, say you're not sure and suggest checking the journey or projects page.

Facts about Sanyam Jain:
- Role: AI-ML Engineer, Researcher, Backend Engineer. Based in Delhi, India.
- Current: Research Assistant / Project Scientist at IIT Delhi DAIR, advised by Dr Parag Singla and Dr Rohan Paul. Working on text2game pipelines, world models, and action-guided diffusion models.
- Always looking to work at startups in frontier and deep tech — robotics, or companies building their own models like Sarvam or Smallest.
- Founder projects: Noteweave (an auto-scientist VSCode plugin that searches arXiv/bioRxiv/PubMed/OpenReview, critiques research ideas like an ICLR reviewer, and hands a plan to coding agents — noteweave.io) and Discoverminds.ai (an open-source AI-powered LinkedIn network search agent).
- Past roles: ML Engineer 1 at Thena.ai, ML Engineer R&D at Figr Design, ML Research Intern at Writesonic (YC S21), UG Research Associate at IIIT Delhi, SWE Intern at Nokia, Data Science Intern at EY, ML Contributor at Unify (YC W23).
- Education: Dual Diploma in Data Science & Programming (BS) from IIT Madras, B.Tech in Computer Science & Engineering from Manipal University Jaipur.
- Personal: grew up in a Baniya family that built a D2C computer hardware business over 30 years. Plays chess and has played flute and tabla. Interested in the latest AI research and anime.
- Contact: sanyam0605@gmail.com, linkedin.com/in/sanyamjain2002, github.com/Sj0605-DataSci.`

type Phase = 'idle' | 'loading' | 'listening' | 'thinking' | 'speaking' | 'error'

interface VoiceAgentElements {
  btn: HTMLButtonElement
  label: HTMLElement
  status: HTMLElement
  transcript: HTMLElement
  youLine: HTMLElement
  replyLine: HTMLElement
}

function getElements(): VoiceAgentElements | null {
  const btn = document.getElementById('voice-agent-btn')
  const label = document.getElementById('voice-agent-label')
  const status = document.getElementById('voice-agent-status')
  const transcript = document.getElementById('voice-agent-transcript')
  const youLine = document.getElementById('voice-agent-you')
  const replyLine = document.getElementById('voice-agent-reply')
  if (
    !(btn instanceof HTMLButtonElement) ||
    label === null ||
    status === null ||
    transcript === null ||
    youLine === null ||
    replyLine === null
  ) {
    return null
  }
  return { btn, label, status, transcript, youLine, replyLine }
}

class VoiceAgent {
  private els: VoiceAgentElements
  private phase: Phase = 'idle'
  private modelsReady = false

  private transcriber: any = null
  private tokenizer: any = null
  private llm: any = null
  private tts: any = null

  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private audioCtx: AudioContext | null = null

  constructor(els: VoiceAgentElements) {
    this.els = els
    this.els.btn.addEventListener('click', () => void this.handleClick())
  }

  /** Entry point for the first click, forwarded from the lazy-loading bootstrap in main.ts. */
  start(): void {
    void this.handleClick()
  }

  private setPhase(phase: Phase, statusText = ''): void {
    this.phase = phase
    this.els.btn.classList.toggle('is-listening', phase === 'listening')
    this.els.btn.classList.toggle('is-speaking', phase === 'thinking' || phase === 'speaking')
    this.els.btn.setAttribute('aria-pressed', String(phase !== 'idle' && phase !== 'error'))
    this.els.status.textContent = statusText

    const labels: Record<Phase, string> = {
      idle: 'ask about me — tap to talk',
      loading: 'loading voice agent…',
      listening: 'listening… tap to stop',
      thinking: 'thinking…',
      speaking: 'speaking…',
      error: 'ask about me — tap to talk',
    }
    this.els.label.textContent = labels[phase]
  }

  private async handleClick(): Promise<void> {
    if (this.phase === 'loading' || this.phase === 'thinking' || this.phase === 'speaking') return

    if (this.phase === 'listening') {
      this.stopRecording()
      return
    }

    if (!this.modelsReady) {
      await this.loadModels()
      if (!this.modelsReady) return
    }

    await this.startRecording()
  }

  private async loadModels(): Promise<void> {
    this.setPhase('loading', 'downloading models (one-time, ~200MB)…')
    try {
      this.transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
        device: 'webgpu',
      })

      this.tokenizer = await AutoTokenizer.from_pretrained('LiquidAI/LFM2.5-230M-ONNX')
      this.llm = await AutoModelForCausalLM.from_pretrained('LiquidAI/LFM2.5-230M-ONNX', {
        device: 'webgpu',
        dtype: 'q4',
      })

      this.tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
      })

      this.modelsReady = true
      this.setPhase('idle')
    } catch (err) {
      console.error('voice agent: failed to load models', err)
      this.setPhase('error', 'could not load voice agent — try a browser with WebGPU (chrome/edge)')
    }
  }

  private async startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.audioChunks = []
      this.mediaRecorder = new MediaRecorder(stream)
      this.mediaRecorder.addEventListener('dataavailable', (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data)
      })
      this.mediaRecorder.addEventListener('stop', () => {
        stream.getTracks().forEach((t) => t.stop())
        void this.handleRecordingStopped()
      })
      this.mediaRecorder.start()
      this.setPhase('listening')
    } catch (err) {
      console.error('voice agent: mic access failed', err)
      this.setPhase('error', 'microphone access denied')
    }
  }

  private stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
  }

  private async handleRecordingStopped(): Promise<void> {
    this.setPhase('thinking', 'transcribing…')
    const blob = new Blob(this.audioChunks, { type: 'audio/webm' })
    const audioData = await this.decodeAudio(blob)

    const result = await this.transcriber(audioData)
    const text: string = Array.isArray(result) ? result[0]?.text ?? '' : result.text ?? ''
    const question = text.trim()

    if (!question) {
      this.setPhase('idle', "didn't catch that — try again")
      return
    }

    this.els.transcript.hidden = false
    this.els.youLine.textContent = question
    this.els.replyLine.textContent = ''

    this.setPhase('thinking', 'thinking…')
    const answer = await this.generateAnswer(question)
    this.els.replyLine.textContent = answer

    this.setPhase('speaking', 'speaking…')
    await this.speak(answer)
    this.setPhase('idle')
  }

  private async decodeAudio(blob: Blob): Promise<Float32Array> {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: 16000 })
    }
    const arrayBuffer = await blob.arrayBuffer()
    const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer)
    return audioBuffer.getChannelData(0)
  }

  private async generateAnswer(question: string): Promise<string> {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question },
    ]
    const inputs = this.tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    })

    let generated = ''
    const streamer = new TextStreamer(this.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        generated += text
      },
    })

    await this.llm.generate({
      ...inputs,
      max_new_tokens: 150,
      do_sample: false,
      streamer,
    })

    return generated.trim() || "i'm not sure — check the journey or projects page for more."
  }

  private async speak(text: string): Promise<void> {
    const audio = await this.tts.generate(text, { voice: 'af_heart' })
    const blob = audio.toBlob()
    const url = URL.createObjectURL(blob)
    const player = new Audio(url)
    await new Promise<void>((resolve) => {
      player.addEventListener('ended', () => resolve())
      player.addEventListener('error', () => resolve())
      void player.play()
    })
    URL.revokeObjectURL(url)
  }
}

export function initVoiceAgent(): VoiceAgent | null {
  const els = getElements()
  if (els === null) return null
  return new VoiceAgent(els)
}
