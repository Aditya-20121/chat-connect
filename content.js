const PROVIDERS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    newUrl: 'https://chatgpt.com/',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    user: { sel: '[data-message-author-role="user"]', textSel: '.whitespace-pre-wrap, .markdown' },
    bot: { sel: '[data-message-author-role="assistant"]', textSel: '.whitespace-pre-wrap, .markdown' },
    composerSel: '#prompt-textarea, div.ProseMirror[contenteditable="true"]',
    charLimit: 40000,
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    newUrl: 'https://claude.ai/new',
    hosts: ['claude.ai'],
    user: { sel: '[data-testid="user-message"]' },
    bot: { sel: '.font-claude-response' },
    composerSel: 'div[data-testid="chat-input"][contenteditable="true"]',
    charLimit: 40000,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    newUrl: 'https://gemini.google.com/app',
    hosts: ['gemini.google.com'],
    user: { sel: 'user-query-content', textSel: '.query-text, .query-text-line' },
    bot: { sel: 'model-response', textSel: 'message-content .markdown' },
    composerSel: '.ql-editor[contenteditable="true"]',
    charLimit: 40000,
  },
};

const BY_HOST = Object.fromEntries(
  Object.values(PROVIDERS).flatMap((p) => p.hosts.map((h) => [h, p]))
);

const getProvider = () => BY_HOST[location.hostname] || null;

const STRIP =
  'button, svg, [aria-hidden="true"], response-element, sources-list, message-actions';

function extractText(node, spec) {
  // Query the live node before cloning: cloning a custom element (Gemini's
  // <user-query-content>) re-runs its upgrade lifecycle offscreen.
  const parts = spec.textSel ? [...node.querySelectorAll(spec.textSel)] : [node];
  return parts
    .map((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(STRIP).forEach((n) => n.remove());
      // innerText needs layout; on a detached node it silently falls back to
      // textContent semantics and every paragraph break is lost.
      clone.style.cssText = 'position:fixed;left:-99999px;top:0';
      document.body.appendChild(clone);
      const text = clone.innerText.trim();
      clone.remove();
      return text;
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function scrapeThread(p) {
  const messages = [];
  for (const node of document.querySelectorAll(`${p.user.sel}, ${p.bot.sel}`)) {
    const isUser = node.matches(p.user.sel);
    const text = extractText(node, isUser ? p.user : p.bot);
    if (text) messages.push({ role: isUser ? 'user' : 'assistant', text });
  }
  return {
    v: 1,
    provider: p.id,
    providerLabel: p.label,
    title: document.title,
    url: location.href,
    ts: Date.now(),
    messages,
  };
}
