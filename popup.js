const PROVIDERS = {
  chatgpt: { label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'] },
  claude: { label: 'Claude', hosts: ['claude.ai'] },
  gemini: { label: 'Gemini', hosts: ['gemini.google.com'] },
};

const BY_HOST = Object.fromEntries(
  Object.entries(PROVIDERS).flatMap(([id, p]) => p.hosts.map((h) => [h, id]))
);

const status = document.getElementById('status');
const targets = document.getElementById('targets');

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const here = tab?.url ? BY_HOST[new URL(tab.url).hostname] : null;

  if (!here) {
    status.textContent = 'Open a ChatGPT, Claude, or Gemini conversation to transfer it.';
    return;
  }

  status.textContent = `Send this ${PROVIDERS[here].label} conversation to:`;

  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (id === here) continue;
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'handoff', target: id });
      if (!r?.ok) {
        status.textContent = r?.error || 'Could not read this conversation.';
        btn.disabled = false;
        return;
      }
      await chrome.tabs.create({ url: r.url });
      window.close();
    });
    targets.appendChild(btn);
  }
})();
