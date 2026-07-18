// Build-time knowledge base extractor. Pulls clean text chunks out of the
// site's own pages (+ llms.txt) into public/kb.json, which the chat widget's
// worker fetches and embeds at load time for retrieval-grounded answers —
// so "ask anything about Sanyam" is answered from what's actually on the
// site, not from the LLM's own (unreliable) memory.
import { parse } from 'node-html-parser'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function text(el) {
  return el.text.replace(/\s+/g, ' ').trim()
}

const chunks = []

function addChunk(source, section, body) {
  const clean = body.replace(/\s+/g, ' ').trim()
  if (clean.length < 20) return
  chunks.push({ source, section, text: clean })
}

// ── llms.txt: split on "## heading" sections ────────────────────────────
function extractLlmsTxt() {
  const raw = readFileSync(join(root, 'public/llms.txt'), 'utf-8')
  const sections = raw.split(/\n(?=## )/g)
  for (const section of sections) {
    const headingMatch = section.match(/^## (.+)/)
    if (!headingMatch) continue
    const heading = headingMatch[1].trim()
    const body = section.replace(/^## .+\n/, '').trim()
    if (!body) continue
    // Split into per-entry chunks on blank-line-separated or "- " bullet groups.
    const entries = body.split(/\n(?=- )/g).filter((e) => e.trim())
    if (entries.length > 1) {
      for (const entry of entries) addChunk('llms.txt', heading, entry)
    } else {
      addChunk('llms.txt', heading, body)
    }
  }
}

// ── index.html: the .about paragraphs ───────────────────────────────────
function extractIndex() {
  const html = readFileSync(join(root, 'index.html'), 'utf-8')
  const doc = parse(html)
  const about = doc.querySelector('.about')
  if (!about) return
  for (const p of about.querySelectorAll('p')) {
    if (p.classList.contains('ai-note')) continue
    addChunk('index.html', 'about', text(p))
  }
}

// ── journey.html: each .timeline-item ───────────────────────────────────
function extractJourney() {
  const html = readFileSync(join(root, 'journey.html'), 'utf-8')
  const doc = parse(html)
  for (const item of doc.querySelectorAll('.timeline-item')) {
    const title = item.querySelector('.timeline-title')
    const role = item.querySelector('.timeline-role')
    const desc = item.querySelector('.timeline-desc')
    const year = item.querySelector('.timeline-year')
    const parts = [title, role, year, desc].filter(Boolean).map(text)
    addChunk('journey.html', text(title) || 'journey', parts.join('. '))
  }
}

// ── projects.html: each .project-card ───────────────────────────────────
function extractProjects() {
  const html = readFileSync(join(root, 'projects.html'), 'utf-8')
  const doc = parse(html)
  for (const card of doc.querySelectorAll('.project-card')) {
    const name = card.querySelector('.project-name')
    const desc = card.querySelector('.project-desc')
    const tags = card.querySelectorAll('.tag').map(text).join(', ')
    const parts = [desc ? text(desc) : '', tags ? `Tech: ${tags}` : ''].filter(Boolean)
    addChunk('projects.html', text(name) || 'project', parts.join('. '))
  }
}

// ── life.html: each .life-section ───────────────────────────────────────
function extractLife() {
  const html = readFileSync(join(root, 'life.html'), 'utf-8')
  const doc = parse(html)
  for (const section of doc.querySelectorAll('.life-section')) {
    const heading = section.querySelector('h2')
    const paras = section.querySelectorAll('p').map(text).join(' ')
    const places = section.querySelectorAll('.place').map(text).join(', ')
    const body = [paras, places ? `Places: ${places}` : ''].filter(Boolean).join(' ')
    addChunk('life.html', text(heading) || 'life', body)
  }
}

// ── blogs.html: each .blog-item title + excerpt ─────────────────────────
function extractBlogs() {
  const html = readFileSync(join(root, 'blogs.html'), 'utf-8')
  const doc = parse(html)
  for (const item of doc.querySelectorAll('.blog-item')) {
    const title = item.querySelector('.blog-title')
    const excerpt = item.querySelector('.blog-excerpt')
    const parts = [title, excerpt].filter(Boolean).map(text)
    addChunk('blogs.html', text(title) || 'writing', parts.join(': '))
  }
}

extractLlmsTxt()
extractIndex()
extractJourney()
extractProjects()
extractLife()
extractBlogs()

writeFileSync(join(root, 'public/kb.json'), JSON.stringify(chunks, null, 2))
console.log(`Built knowledge base: ${chunks.length} chunks -> public/kb.json`)
