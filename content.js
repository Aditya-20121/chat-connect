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

console.log('[Chat Connect] provider:', getProvider()?.id ?? 'none');
