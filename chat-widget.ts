import { VoiceAgentEngine, type AgentPhase } from './voice-agent'

const WIDGET_HTML = `
<button id="cw-bubble" class="cw-bubble" type="button" aria-label="ask about sanyam" aria-expanded="false">
  <span class="cw-bubble-icon">
    <span class="voice-bar"></span><span class="voice-bar"></span><span class="voice-bar"></span>
  </span>
</button>

<div id="cw-panel" class="cw-panel" hidden>
  <div class="cw-panel-header">
    <span>ai mode — ask about sanyam</span>
    <button id="cw-close" class="cw-close" type="button" aria-label="close">&times;</button>
  </div>

  <div id="cw-visualizer" class="cw-visualizer">
    <span class="bar"></span><span class="bar"></span><span class="bar"></span>
    <span class="bar"></span><span class="bar"></span><span class="bar"></span>
    <span class="bar"></span><span class="bar"></span><span class="bar"></span>
  </div>

  <p id="cw-status" class="cw-status"></p>
  <div id="cw-progress" class="cw-progress" hidden>
    <div id="cw-progress-bar" class="cw-progress-bar"></div>
  </div>

  <div id="cw-log" class="cw-log">
    <p class="cw-empty">ask something like "what is sanyam working on right now?"</p>
  </div>

  <div class="cw-input-row">
    <input id="cw-text-input" class="cw-text-input" type="text" placeholder="ask about sanyam…" autocomplete="off">
    <button id="cw-mic-btn" class="cw-icon-btn mic" type="button" aria-pressed="false" title="talk">🎙</button>
    <button id="cw-send-btn" class="cw-icon-btn send" type="button" title="send">↑</button>
  </div>
</div>
`

const WIDGET_CSS = `
.cw-bubble {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 200;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0,0,0,0.12);
  transition: border-color 0.15s, transform 0.15s;
}
.cw-bubble:hover { border-color: var(--fg); transform: scale(1.05); }

.cw-bubble-icon { display: inline-flex; align-items: center; gap: 2px; height: 14px; }
.cw-bubble-icon .voice-bar { width: 2px; height: 8px; border-radius: 1px; background: var(--muted); }

.cw-panel {
  position: fixed;
  bottom: 88px;
  right: 24px;
  z-index: 200;
  width: min(360px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 120px));
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.16);
  overflow: hidden;
}

.cw-panel[hidden] { display: none; }

.cw-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--fg);
}

.cw-close {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
}
.cw-close:hover { color: var(--fg); }

.cw-visualizer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 40px;
  margin: 10px 0 4px;
}
.cw-visualizer .bar {
  width: 2px;
  height: 6px;
  border-radius: 1px;
  background: var(--border);
  transition: height 0.12s ease, background 0.15s;
}
.cw-visualizer.is-active .bar {
  background: var(--fg);
  animation: cw-pulse 1s ease-in-out infinite;
}
.cw-visualizer .bar:nth-child(1) { animation-delay: 0s; }
.cw-visualizer .bar:nth-child(2) { animation-delay: 0.08s; }
.cw-visualizer .bar:nth-child(3) { animation-delay: 0.16s; }
.cw-visualizer .bar:nth-child(4) { animation-delay: 0.24s; }
.cw-visualizer .bar:nth-child(5) { animation-delay: 0.32s; }
.cw-visualizer .bar:nth-child(6) { animation-delay: 0.24s; }
.cw-visualizer .bar:nth-child(7) { animation-delay: 0.16s; }
.cw-visualizer .bar:nth-child(8) { animation-delay: 0.08s; }
.cw-visualizer .bar:nth-child(9) { animation-delay: 0s; }
@keyframes cw-pulse { 0%, 100% { height: 6px; } 50% { height: 28px; } }

.cw-status {
  font-size: 11px;
  color: var(--muted);
  font-family: "SF Mono", ui-monospace, monospace;
  text-align: center;
  min-height: 15px;
  margin-bottom: 4px;
}

.cw-progress {
  width: 80%;
  height: 3px;
  margin: 0 auto 10px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
}
.cw-progress-bar { height: 100%; width: 0%; background: var(--fg); transition: width 0.2s ease; }

.cw-log {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 14px 14px;
  min-height: 80px;
}

.cw-msg {
  max-width: 88%;
  font-size: 13px;
  line-height: 1.55;
  padding: 8px 12px;
  border-radius: 10px;
}
.cw-msg.user { align-self: flex-end; background: var(--hover-bg); color: var(--fg); }
.cw-msg.agent { align-self: flex-start; color: var(--fg); border: 1px solid var(--border); }

.cw-empty { color: var(--muted); font-size: 12px; text-align: center; padding: 20px 8px; }

.cw-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid var(--border);
  padding: 10px 12px;
}

.cw-text-input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  font-family: inherit;
  color: var(--fg);
  min-width: 0;
}
.cw-text-input::placeholder { color: var(--muted); }

.cw-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  font-size: 13px;
  flex-shrink: 0;
  transition: border-color 0.15s, background 0.15s;
}
.cw-icon-btn:hover { border-color: var(--fg); background: var(--hover-bg); }
.cw-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cw-icon-btn.mic.is-recording { background: var(--fg); color: var(--bg); border-color: var(--fg); }

@media (max-width: 420px) {
  .cw-panel { right: 16px; left: 16px; width: auto; bottom: 84px; }
  .cw-bubble { right: 16px; bottom: 16px; }
}
`

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

export function mountChatWidget(): void {
  if (document.getElementById('cw-bubble')) return // already mounted

  const style = document.createElement('style')
  style.textContent = WIDGET_CSS
  document.head.appendChild(style)

  const container = document.createElement('div')
  container.innerHTML = WIDGET_HTML
  document.body.appendChild(container)

  const bubble = el<HTMLButtonElement>('cw-bubble')
  const panel = el('cw-panel')
  const closeBtn = el<HTMLButtonElement>('cw-close')
  const visualizer = el('cw-visualizer')
  const status = el('cw-status')
  const progressWrap = el('cw-progress')
  const progressBar = el('cw-progress-bar')
  const log = el('cw-log')
  const textInput = el<HTMLInputElement>('cw-text-input')
  const micBtn = el<HTMLButtonElement>('cw-mic-btn')
  const sendBtn = el<HTMLButtonElement>('cw-send-btn')

  if (
    !bubble || !panel || !closeBtn || !visualizer || !status || !progressWrap ||
    !progressBar || !log || !textInput || !micBtn || !sendBtn
  ) {
    return
  }
  const bubbleEl = bubble
  const panelEl = panel
  const visualizerEl = visualizer
  const statusEl = status
  const progressWrapEl = progressWrap
  const progressBarEl = progressBar
  const logEl = log
  const textInputEl = textInput
  const micBtnEl = micBtn
  const sendBtnEl = sendBtn

  let hasMessages = false
  function clearEmptyState(): void {
    if (hasMessages) return
    hasMessages = true
    logEl.innerHTML = ''
  }

  function addMessage(role: 'user' | 'agent', text: string): HTMLElement {
    clearEmptyState()
    const p = document.createElement('p')
    p.className = `cw-msg ${role}`
    p.textContent = text
    logEl.appendChild(p)
    logEl.scrollTop = logEl.scrollHeight
    return p
  }

  let currentReplyEl: HTMLElement | null = null
  let engine: VoiceAgentEngine | null = null
  let prefetched = false

  function getEngine(): VoiceAgentEngine {
    if (!engine) {
      engine = new VoiceAgentEngine({
        onPhaseChange: (phase: AgentPhase, statusText: string) => {
          statusEl.textContent = statusText
          visualizerEl.classList.toggle('is-active', phase === 'listening' || phase === 'speaking')
          micBtnEl.classList.toggle('is-recording', phase === 'listening')
          const busy = phase === 'loading' || phase === 'thinking'
          micBtnEl.disabled = busy
          sendBtnEl.disabled = busy
          textInputEl.disabled = busy
          if (phase === 'loading') progressWrapEl.hidden = false
          else if (phase !== 'error') progressWrapEl.hidden = true
        },
        onLoadProgress: ({ label, progress }) => {
          statusEl.textContent = label
          if (progress >= 0) progressBarEl.style.width = `${Math.round(progress)}%`
        },
        onAudioLevel: (level: number) => {
          const bars = visualizerEl.querySelectorAll<HTMLElement>('.bar')
          bars.forEach((bar, i) => {
            const jitter = 0.6 + Math.sin(i * 1.3) * 0.4
            const h = 6 + level * 30 * jitter
            bar.style.height = `${Math.max(6, h)}px`
          })
        },
        onSpokenChunk: (chunkText: string) => {
          if (!currentReplyEl) currentReplyEl = addMessage('agent', '')
          currentReplyEl.textContent = (currentReplyEl.textContent ?? '') + chunkText
          logEl.scrollTop = logEl.scrollHeight
        },
        onReplyDone: (fullText: string) => {
          if (!currentReplyEl) addMessage('agent', fullText)
        },
      })
    }
    return engine
  }

  async function handleAsk(question: string): Promise<void> {
    if (!question.trim()) return
    addMessage('user', question)
    currentReplyEl = null
    await getEngine().ask(question)
  }

  function openPanel(): void {
    panelEl.hidden = false
    bubbleEl.setAttribute('aria-expanded', 'true')
    if (!prefetched) {
      prefetched = true
      void getEngine().prefetch()
    }
  }

  function closePanel(): void {
    panelEl.hidden = true
    bubbleEl.setAttribute('aria-expanded', 'false')
  }

  bubbleEl.addEventListener('click', () => {
    if (panelEl.hidden) openPanel()
    else closePanel()
  })
  closeBtn.addEventListener('click', closePanel)

  micBtnEl.addEventListener('click', () => {
    const e = getEngine()
    if (e.getPhase() === 'listening') {
      void e.stopRecordingAndTranscribe().then((text) => {
        if (text) void handleAsk(text)
        else statusEl.textContent = "didn't catch that — try again"
      })
    } else {
      void e.startRecording()
    }
  })

  sendBtnEl.addEventListener('click', () => {
    const text = textInputEl.value
    textInputEl.value = ''
    void handleAsk(text)
  })

  textInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendBtnEl.click()
    }
  })
}
