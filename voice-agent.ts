export type AgentPhase = 'idle' | 'loading' | 'warming-up' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface LoadProgress {
  label: string
  progress: number // 0-100
}

export interface VoiceAgentCallbacks {
  onPhaseChange?: (phase: AgentPhase, statusText: string) => void
  onLoadProgress?: (progress: LoadProgress) => void
  onTranscript?: (text: string) => void
  /** Called once per sentence, right as its audio starts playing — keeps text in sync with voice. */
  onSpokenChunk?: (chunkText: string) => void
  onReplyDone?: (fullText: string) => void
  onAudioLevel?: (level: number) => void // 0-1, while mic recording or agent speaking
}

type MainToWorker =
  | { type: 'load' }
  | { type: 'transcribe'; audio: Float32Array }
  | { type: 'ask'; question: string }
  | { type: 'stop' }

type WorkerToMain =
  | { type: 'load-progress'; label: string; progress: number }
  | { type: 'ready' }
  | { type: 'warm-up-progress'; progress: number }
  | { type: 'warm-up-done' }
  | { type: 'load-error'; message: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply-done'; text: string }
  | { type: 'audio-chunk'; buffer: ArrayBuffer; sampleRate: number; text: string }
  | { type: 'speaking-done' }
  | { type: 'error'; message: string }

// All model inference (Whisper, LFM2.5, Kokoro) runs inside this Worker so the
// main thread — and the page's own animations/scroll/clicks — never freezes,
// no matter how heavy a single generation step is.
export class VoiceAgentEngine {
  private callbacks: VoiceAgentCallbacks
  private phase: AgentPhase = 'idle'
  private worker: Worker | null = null
  private readyPromise: Promise<boolean> | null = null
  private resolveReady: ((ok: boolean) => void) | null = null

  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private micAudioCtx: AudioContext | null = null
  private micAnalyser: AnalyserNode | null = null
  private micLevelRaf = 0

  private playbackCtx: AudioContext | null = null
  private playQueue: { buffer: AudioBuffer; text: string }[] = []
  private isPlaying = false
  private playbackAnalyser: AnalyserNode | null = null
  private playbackLevelRaf = 0
  private currentSource: AudioBufferSourceNode | null = null
  private pendingTranscribe: { resolve: (text: string) => void } | null = null
  private pendingAsk: { resolve: () => void } | null = null

  constructor(callbacks: VoiceAgentCallbacks = {}) {
    this.callbacks = callbacks
  }

  getPhase(): AgentPhase {
    return this.phase
  }

  private setPhase(phase: AgentPhase, statusText = ''): void {
    this.phase = phase
    this.callbacks.onPhaseChange?.(phase, statusText)
  }

  /** Spins up the worker and kicks off model downloads; safe to call multiple times. */
  prefetch(): Promise<boolean> {
    if (this.readyPromise) return this.readyPromise
    this.setPhase('loading', 'loading models…')

    this.readyPromise = new Promise<boolean>((resolve) => {
      this.resolveReady = resolve
    })

    this.worker = new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e: MessageEvent<WorkerToMain>) => this.handleWorkerMessage(e.data))
    this.worker.addEventListener('error', (e) => {
      console.error('voice agent: worker error', e)
      this.setPhase('error', 'could not load the ai models — try chrome or edge with webgpu enabled')
      this.resolveReady?.(false)
    })

    this.postToWorker({ type: 'load' })
    return this.readyPromise
  }

  private postToWorker(msg: MainToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer)
  }

  private handleWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'load-progress':
        this.callbacks.onLoadProgress?.({ label: msg.label, progress: msg.progress })
        break
      case 'ready':
        this.setPhase('warming-up', 'warming up…')
        this.callbacks.onLoadProgress?.({ label: 'warming up…', progress: 0 })
        break
      case 'warm-up-progress':
        this.callbacks.onLoadProgress?.({ label: 'warming up…', progress: msg.progress })
        break
      case 'warm-up-done':
        this.setPhase('idle')
        this.resolveReady?.(true)
        break
      case 'load-error':
        console.error('voice agent: model load failed in worker', msg.message)
        this.setPhase('error', 'could not load the ai models — try chrome or edge with webgpu enabled')
        this.resolveReady?.(false)
        break
      case 'transcript':
        this.pendingTranscribe?.resolve(msg.text)
        this.pendingTranscribe = null
        break
      case 'reply-done':
        this.callbacks.onReplyDone?.(msg.text)
        break
      case 'audio-chunk':
        void this.enqueueAudioChunk(msg.buffer, msg.sampleRate, msg.text)
        break
      case 'speaking-done':
        void this.waitForPlaybackDrain().then(() => {
          this.setPhase('idle')
          this.pendingAsk?.resolve()
          this.pendingAsk = null
        })
        break
      case 'error':
        console.error('voice agent: worker error', msg.message)
        this.setPhase('error', 'something went wrong — try again')
        this.pendingAsk?.resolve()
        this.pendingAsk = null
        break
    }
  }

  async ensureReady(): Promise<boolean> {
    if (this.phase !== 'error' && this.readyPromise) return this.readyPromise
    return this.prefetch()
  }

  // ── voice input (mic capture stays on the main thread — Workers have no DOM) ──

  async startRecording(): Promise<void> {
    if (!(await this.ensureReady())) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.audioChunks = []
      this.mediaRecorder = new MediaRecorder(stream)
      this.mediaRecorder.addEventListener('dataavailable', (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data)
      })
      this.mediaRecorder.addEventListener('stop', () => {
        stream.getTracks().forEach((t) => t.stop())
        this.stopMicLevelMeter()
      })
      this.mediaRecorder.start()
      this.startMicLevelMeter(stream)
      this.setPhase('listening', 'listening…')
    } catch (err) {
      console.error('voice agent: mic access failed', err)
      this.setPhase('error', 'microphone access denied')
    }
  }

  async stopRecordingAndTranscribe(): Promise<string> {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return ''

    const stopped = new Promise<void>((resolve) => {
      this.mediaRecorder!.addEventListener('stop', () => resolve(), { once: true })
    })
    this.mediaRecorder.stop()
    await stopped

    this.setPhase('thinking', 'transcribing…')
    const blob = new Blob(this.audioChunks, { type: 'audio/webm' })
    const audioData = await this.decodeToFloat32(blob)

    const text = await new Promise<string>((resolve) => {
      this.pendingTranscribe = { resolve }
      // Float32Array is transferable via its underlying buffer.
      this.postToWorker({ type: 'transcribe', audio: audioData }, [audioData.buffer])
    })
    return text
  }

  private startMicLevelMeter(stream: MediaStream): void {
    if (!this.micAudioCtx) this.micAudioCtx = new AudioContext()
    const source = this.micAudioCtx.createMediaStreamSource(stream)
    this.micAnalyser = this.micAudioCtx.createAnalyser()
    this.micAnalyser.fftSize = 256
    source.connect(this.micAnalyser)

    const data = new Uint8Array(this.micAnalyser.frequencyBinCount)
    const tick = (): void => {
      if (!this.micAnalyser) return
      this.micAnalyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (const v of data) {
        const norm = (v - 128) / 128
        sumSquares += norm * norm
      }
      const rms = Math.sqrt(sumSquares / data.length)
      this.callbacks.onAudioLevel?.(Math.min(1, rms * 4))
      this.micLevelRaf = requestAnimationFrame(tick)
    }
    tick()
  }

  private stopMicLevelMeter(): void {
    cancelAnimationFrame(this.micLevelRaf)
    this.micAnalyser = null
    this.callbacks.onAudioLevel?.(0)
  }

  private async decodeToFloat32(blob: Blob): Promise<Float32Array> {
    const ctx = new AudioContext({ sampleRate: 16000 })
    const arrayBuffer = await blob.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    return audioBuffer.getChannelData(0).slice()
  }

  // ── text + voice output ─────────────────────────────────────────────────

  /** Full turn: given user text, generate a reply (streamed) and speak it (streamed). */
  async ask(question: string): Promise<void> {
    if (!(await this.ensureReady())) return

    this.callbacks.onTranscript?.(question)
    this.setPhase('thinking', 'thinking…')

    await new Promise<void>((resolve) => {
      this.pendingAsk = { resolve }
      this.postToWorker({ type: 'ask', question })
    })
  }

  // ── streamed audio playback ─────────────────────────────────────────────

  private async enqueueAudioChunk(buffer: ArrayBuffer, sampleRate: number, text: string): Promise<void> {
    if (!this.playbackCtx) this.playbackCtx = new AudioContext()
    const floatData = new Float32Array(buffer)
    const audioBuffer = this.playbackCtx.createBuffer(1, floatData.length, sampleRate)
    audioBuffer.copyToChannel(floatData, 0)
    this.playQueue.push({ buffer: audioBuffer, text })
    if (this.phase !== 'speaking') this.setPhase('speaking', 'speaking…')
    if (!this.isPlaying) void this.drainQueue()
  }

  private async drainQueue(): Promise<void> {
    if (!this.playbackCtx) return
    this.isPlaying = true

    if (!this.playbackAnalyser) {
      this.playbackAnalyser = this.playbackCtx.createAnalyser()
      this.playbackAnalyser.fftSize = 256
      this.playbackAnalyser.connect(this.playbackCtx.destination)
      this.startPlaybackLevelMeter()
    }

    while (this.playQueue.length > 0) {
      const chunk = this.playQueue.shift()!
      this.callbacks.onSpokenChunk?.(chunk.text)
      await new Promise<void>((resolve) => {
        const source = this.playbackCtx!.createBufferSource()
        source.buffer = chunk.buffer
        source.connect(this.playbackAnalyser!)
        source.addEventListener('ended', () => resolve())
        this.currentSource = source
        source.start()
      })
    }

    this.currentSource = null
    this.isPlaying = false
    this.stopPlaybackLevelMeter()
  }

  /** Immediately halts playback and tells the worker to stop generating further audio. */
  stop(): void {
    this.postToWorker({ type: 'stop' })
    this.playQueue = []
    if (this.currentSource) {
      try {
        this.currentSource.stop()
      } catch {
        // already stopped
      }
      this.currentSource = null
    }
    this.isPlaying = false
    this.stopPlaybackLevelMeter()
    this.setPhase('idle')
    this.pendingAsk?.resolve()
    this.pendingAsk = null
  }

  private async waitForPlaybackDrain(): Promise<void> {
    while (this.isPlaying || this.playQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  private startPlaybackLevelMeter(): void {
    if (!this.playbackAnalyser) return
    const data = new Uint8Array(this.playbackAnalyser.frequencyBinCount)
    const tick = (): void => {
      if (!this.playbackAnalyser) return
      this.playbackAnalyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (const v of data) {
        const norm = (v - 128) / 128
        sumSquares += norm * norm
      }
      const rms = Math.sqrt(sumSquares / data.length)
      this.callbacks.onAudioLevel?.(Math.min(1, rms * 4))
      this.playbackLevelRaf = requestAnimationFrame(tick)
    }
    tick()
  }

  private stopPlaybackLevelMeter(): void {
    cancelAnimationFrame(this.playbackLevelRaf)
    this.callbacks.onAudioLevel?.(0)
  }
}
