import { prepare, layout, prepareWithSegments, layoutWithLines } from '@chenglou/pretext'
import { inject } from '@vercel/analytics'

inject()

// ── pretext canvas demo ───────────────────────────────────────────────────────
// Renders a paragraph onto a <canvas> using pretext for text measurement.
// Zero DOM reflow — no getBoundingClientRect, no offsetHeight.
function initPretextDemo(): void {
  const el = document.getElementById('pretext-canvas')
  if (!(el instanceof HTMLCanvasElement)) return
  const canvas: HTMLCanvasElement = el

  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const c: CanvasRenderingContext2D = ctx

  const font = '14px "Helvetica Neue", Helvetica, Arial, sans-serif'
  const text =
    'pretext measures text height and line widths purely in javascript — ' +
    'no dom layout, no reflow, just arithmetic over cached glyph widths. ' +
    'this canvas is laid out without a single call to getBoundingClientRect.'
  const lineHeight = 22

  function render(): void {
    const dpr = window.devicePixelRatio || 1
    const parent = canvas.parentElement
    const cssWidth = parent !== null ? parent.clientWidth : 600
    const padding = 16
    const contentWidth = Math.max(1, cssWidth - padding * 2)

    canvas.style.width = `${cssWidth}px`

    const prepared = prepareWithSegments(text, font)
    const { lines, height } = layoutWithLines(prepared, contentWidth, lineHeight)

    const cssHeight = height + padding * 2 + 24
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(cssHeight * dpr)
    canvas.style.height = `${cssHeight}px`

    c.scale(dpr, dpr)
    c.clearRect(0, 0, cssWidth, cssHeight)

    for (let i = 0; i < lines.length; i++) {
      const x = padding
      const y = padding + (i + 1) * lineHeight - 4
      const lineW = lines[i].width

      // width bar
      c.fillStyle = '#f5f5f5'
      c.fillRect(padding, padding + i * lineHeight, lineW, lineHeight - 2)

      // text
      c.font = font
      c.fillStyle = '#0a0a0a'
      c.fillText(lines[i].text, x, y)

      // measured width label
      c.font = '10px "SF Mono", ui-monospace, monospace'
      c.fillStyle = '#c8c8c8'
      c.fillText(`${Math.round(lineW)}px`, padding + lineW + 6, y)
    }

    // footer note
    c.font = '10px "SF Mono", ui-monospace, monospace'
    c.fillStyle = '#c8c8c8'
    c.fillText(
      `${lines.length} lines · ${Math.round(height)}px tall · zero dom reflow`,
      padding,
      cssHeight - 6
    )
  }

  render()

  let raf = 0
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(render)
  })
  observer.observe(canvas.parentElement ?? canvas)
}

// ── blog excerpt line count check ────────────────────────────────────────────
// Use pretext to tag each blog excerpt with its measured line count.
function checkBlogExcerpts(): void {
  const excerpts = Array.from(document.querySelectorAll<HTMLElement>('.blog-excerpt'))
  for (const el of excerpts) {
    const text = el.textContent ?? ''
    if (!text.trim()) continue
    const style = getComputedStyle(el)
    const font = `${style.fontSize} ${style.fontFamily}`
    const maxWidth = el.clientWidth || 400
    const lh = parseFloat(style.lineHeight) || 20

    const prepared = prepare(text, font)
    const { lineCount } = layout(prepared, maxWidth, lh)
    el.dataset['lines'] = String(lineCount)
  }
}

// ── init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initPretextDemo()
  checkBlogExcerpts()
})
