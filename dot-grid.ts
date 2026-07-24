// Interactive dot-grid background for the whole site. Dots gently scale up
// and brighten as the cursor nears them, elastic-pull back to rest when it
// moves away — pure canvas, no external assets, stays monochrome via the
// theme's own --fg variable so it adapts with the light/dark toggle.
// Fixed to the viewport (not the document), so it stays put while scrolling
// and only ever renders what's on screen.

interface Dot {
  x: number
  y: number
  radius: number
}

const SPACING = 32
const BASE_RADIUS = 1.1
const MAX_RADIUS = 3
const INFLUENCE_RADIUS = 130

function readFgColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#0a0a0a'
}

export function mountDotGrid(): void {
  if (document.getElementById('dot-grid-canvas')) return // already mounted

  const canvas = document.createElement('canvas')
  canvas.id = 'dot-grid-canvas'
  canvas.style.position = 'fixed'
  canvas.style.inset = '0'
  canvas.style.width = '100vw'
  canvas.style.height = '100vh'
  canvas.style.pointerEvents = 'none'
  canvas.style.zIndex = '-1'
  document.body.prepend(canvas)

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  let dots: Dot[] = []
  let width = 0
  let height = 0
  let mouseX = -9999
  let mouseY = -9999

  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    width = window.innerWidth
    height = window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)

    dots = []
    const cols = Math.ceil(width / SPACING) + 1
    const rows = Math.ceil(height / SPACING) + 1
    const offsetX = (width - (cols - 1) * SPACING) / 2
    const offsetY = (height - (rows - 1) * SPACING) / 2
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots.push({
          x: offsetX + c * SPACING,
          y: offsetY + r * SPACING,
          radius: BASE_RADIUS,
        })
      }
    }
  }

  function drawFrame(): void {
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    const color = readFgColor()

    for (const dot of dots) {
      const dx = dot.x - mouseX
      const dy = dot.y - mouseY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const influence = Math.max(0, 1 - dist / INFLUENCE_RADIUS)
      const targetRadius = BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * influence
      dot.radius += (targetRadius - dot.radius) * 0.2

      const alpha = 0.1 + 0.5 * influence
      ctx.beginPath()
      ctx.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = alpha
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  function render(): void {
    drawFrame()
    requestAnimationFrame(render)
  }

  function handlePointerMove(e: PointerEvent): void {
    mouseX = e.clientX
    mouseY = e.clientY
  }

  function handlePointerLeave(): void {
    mouseX = -9999
    mouseY = -9999
  }

  resize()

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion) {
    drawFrame()
  } else {
    render()
  }

  window.addEventListener('resize', () => {
    resize()
    if (prefersReducedMotion) drawFrame()
  })

  if (!prefersReducedMotion) {
    window.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerleave', handlePointerLeave)
  }
}
