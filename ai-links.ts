// "Talk to ChatGPT / Claude about Sanyam" buttons — deep-links that open a
// fresh chat with /llms.txt prefilled as context via the `q=` param. Both
// products only prefill (no auto-submit param exists on either), so the
// visitor still hits enter themselves.
const INSTRUCTION =
  "Here is Sanyam Jain's profile. Answer questions about him as an assistant who knows him well, based only on this information:\n\n"

async function buildPrompt(): Promise<string> {
  const res = await fetch('/llms.txt')
  const profile = await res.text()
  return `${INSTRUCTION}${profile}`
}

export async function mountAiLinks(): Promise<void> {
  const chatgptBtn = document.getElementById('ai-link-chatgpt')
  const claudeBtn = document.getElementById('ai-link-claude')
  if (!chatgptBtn && !claudeBtn) return

  const prompt = await buildPrompt()
  const q = encodeURIComponent(prompt)

  if (chatgptBtn instanceof HTMLAnchorElement) {
    chatgptBtn.href = `https://chatgpt.com/?q=${q}`
  }
  if (claudeBtn instanceof HTMLAnchorElement) {
    claudeBtn.href = `https://claude.ai/new?q=${q}`
  }
}
