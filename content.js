const PROVIDERS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    newUrl: 'https://chatgpt.com/',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    user: { sel: '[data-message-author-role="user"]', textSel: '.whitespace-pre-wrap, .markdown' },
    bot: { sel: '[data-message-author-role="assistant"]', textSel: '.whitespace-pre-wrap, .markdown' },
    composerSel: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
    charLimit: 40000,
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    newUrl: 'https://claude.ai/new',
    hosts: ['claude.ai'],
    user: { sel: '[data-testid="user-message"]' },
    bot: { sel: '.font-claude-response' },
    composerSel: [
      'div[data-testid="chat-input"][contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    charLimit: 40000,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    newUrl: 'https://gemini.google.com/app',
    hosts: ['gemini.google.com'],
    user: { sel: 'user-query-content', textSel: '.query-text, .query-text-line' },
    bot: { sel: 'model-response', textSel: 'message-content .markdown' },
    composerSel: [
      '.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    charLimit: 40000,
    // Quill keeps only the first line of an execCommand insert, so go straight
    // to the paste path instead of spending a timeout discovering that.
    pasteFirst: true,
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
  // Drop matches nested inside other matches, or the text is counted twice --
  // Gemini's .query-text is the parent of its own .query-text-line children.
  // ponytail: O(n^2), but n is the handful of blocks in one message.
  const parts = spec.textSel
    ? [...node.querySelectorAll(spec.textSel)].filter(
        (el, _i, all) => !all.some((other) => other !== el && other.contains(el))
      )
    : [node];
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

const PENDING = 'pending';
const STALE_MS = 5 * 60 * 1000;

// Quill keeps a hidden .ql-clipboard alongside the real editor, and these apps
// hold offscreen composer instances, so the first match is often not the box on
// screen. Reading back from the wrong element makes every insert look failed.
// Selectors are tried in priority order, so a broad fallback never wins over a
// specific one that also matched.
function findVisible(selectors) {
  for (const selector of selectors) {
    const el = [...document.querySelectorAll(selector)].find(
      (n) => n.getClientRects().length > 0
    );
    if (el) return el;
  }
  return null;
}

function waitFor(selectors, timeoutMs) {
  const found = findVisible(selectors);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = findVisible(selectors);
      if (!el) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

async function waitUntil(fn, timeoutMs = 1200, stepMs = 100) {
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

const landed = (el) => (el.value ?? el.innerText ?? '').trim().length;

// execCommand('selectAll') works on whatever the document has focused, so when
// focus was not inside the composer it selected the entire page -- visibly
// highlighting the whole UI and leaving the insert with no editable target.
// An explicit Range is scoped to the element whether or not focus lands, and
// selecting the contents is itself the "clear": both insert paths replace the
// current selection.
function prepareComposer(el) {
  // Gemini re-renders its composer after load, so a node looked up moments ago
  // may already be detached -- a Range over one throws from addRange.
  if (!el.isConnected) return false;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

// execCommand drives the browser's real editing pipeline, so a React-controlled
// contenteditable sees a genuine beforeinput/input pair. ChatGPT and Claude want
// this; Quill mangles it, keeping only the first line.
function viaExecCommand(el, text) {
  document.execCommand('insertText', false, text);
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })
  );
}

// A synthetic paste arrives as one atomic document the editor converts itself,
// so line breaks survive. ChatGPT turns a large paste into a file attachment
// chip, which is why this is not simply the default everywhere.
function viaPaste(el, text) {
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  el.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  );
}

// Takes selectors, not an element. These apps swap the composer node out from
// under us, and a captured reference goes stale silently: length read back from
// an orphaned node is 0 forever, so every attempt looks like it failed.
async function insertText(selectors, text, pasteFirst) {
  // ponytail: 0.5, not 0.9. The failure this catches is "only the first line
  // arrived" (~2% of the text); editors normalise whitespace enough that a
  // strict threshold rejects a paste that actually worked.
  const want = text.trim().length * 0.5;
  const landedNow = () => {
    const el = findVisible(selectors);
    return el ? landed(el) : 0;
  };
  const enough = () => landedNow() >= want;

  // Re-resolve before every touch, never between a lookup and its use.
  const attempt = (strategy) => {
    const el = findVisible(selectors);
    if (!el) return false;

    if (el.tagName === 'TEXTAREA') {
      el.focus();
      // React tracks the previous value and reverts a plain assignment.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (!prepareComposer(el)) return false;
    strategy(el, text);
    return true;
  };

  let best = null;
  for (const strategy of pasteFirst ? [viaPaste, viaExecCommand] : [viaExecCommand, viaPaste]) {
    if (!attempt(strategy)) continue;
    // Quill processes paste on a timer, hence polling rather than reading back.
    if (await waitUntil(enough)) return true;
    if (!best || landedNow() > best.len) best = { strategy, len: landedNow() };
  }

  // Never leave the composer holding less than some attempt already achieved.
  if (best && best.len > landedNow() && attempt(best.strategy)) {
    await waitUntil(enough, 400);
  }
  return false;
}

// Reloading or updating the extension orphans the content scripts already
// running in open tabs: they keep working, but every chrome.* call throws
// "Extension context invalidated". Checked rather than caught, so the button
// reports it instead of failing as an unhandled rejection with nothing staged.
function alive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

async function handoff(targetId, note) {
  const p = getProvider();
  if (!p) return { ok: false, error: 'Not a supported AI chat page.' };
  if (!alive()) {
    return { ok: false, error: 'Chat Connect was updated — reload this page, then try again.' };
  }

  const thread = scrapeThread(p);
  if (!thread.messages.length) {
    return { ok: false, error: 'Could not read this conversation.' };
  }

  await chrome.storage.local.set({
    [PENDING]: { target: targetId, thread, note, ts: Date.now() },
  });
  return { ok: true, count: thread.messages.length, url: PROVIDERS[targetId].newUrl };
}

async function consumePending() {
  const p = getProvider();
  if (!p) return;

  const { [PENDING]: pending } = await chrome.storage.local.get(PENDING);
  if (!pending || pending.target !== p.id) return;

  // Clear before injecting: a reload mid-inject must not re-fire the paste.
  await chrome.storage.local.remove(PENDING);
  if (Date.now() - pending.ts > STALE_MS) return;

  const text = ChatConnectFormat.toPrompt(pending.thread, p.charLimit, pending.note);
  if (!(await waitFor(p.composerSel, 10000))) {
    return offerClipboard(text, `Couldn't find the ${p.label} composer — are you signed in?`);
  }

  // Checking only for "not empty" was not enough: Gemini kept the opening
  // framing lines and dropped the conversation, which looked like success.
  const ok = await insertText(p.composerSel, text, p.pasteFirst);
  const composer = findVisible(p.composerSel);
  console.log('[Chat Connect] insert', {
    ok,
    provider: p.id,
    expected: text.length,
    landed: composer ? landed(composer) : 0,
    messages: pending.thread.messages.length,
    composer,
  });
  if (!ok) {
    return offerClipboard(text, `Only part of the conversation reached ${p.label}.`);
  }
  toast(`Context from ${pending.thread.providerLabel} pasted — review it, then press Enter.`);
}

const UI_CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; right: 16px; bottom: 96px; z-index: 2147483647;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: 999px;
    background: #18181b; border: 1px solid #3f3f46;
    box-shadow: 0 8px 32px rgba(0,0,0,.45);
    font: 500 12px system-ui, sans-serif; color: #a1a1aa;
  }
  .bar button {
    all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px;
    color: #fafafa; background: #27272a; font: 500 12px system-ui, sans-serif;
  }
  .bar button:hover { background: #3f3f46; }
  .bar input {
    all: unset; width: 120px; padding: 5px 10px; border-radius: 999px;
    background: #27272a; color: #fafafa; font: 400 12px system-ui, sans-serif;
    transition: width .15s ease;
  }
  .bar input::placeholder { color: #71717a; }
  .bar input:focus { width: 220px; background: #3f3f46; }
  .toast {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; display: flex; align-items: center; gap: 10px;
    max-width: 92vw; padding: 10px 16px; border-radius: 12px;
    background: #18181b; border: 1px solid #3f3f46; color: #fafafa;
    box-shadow: 0 8px 32px rgba(0,0,0,.5);
    font: 500 13px system-ui, sans-serif;
  }
  .toast button {
    all: unset; cursor: pointer; padding: 5px 10px; border-radius: 8px;
    background: #fafafa; color: #18181b; font: 600 12px system-ui, sans-serif;
  }
`;

function shadow() {
  let host = document.getElementById('chat-connect-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'chat-connect-root';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    root.appendChild(style);
  }
  return host.shadowRoot;
}

function toast(message, actionLabel, onAction) {
  const root = shadow();
  root.querySelector('.toast')?.remove();

  const el = document.createElement('div');
  el.className = 'toast';
  el.append(message);

  if (actionLabel) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      onAction();
      el.remove();
    });
    el.appendChild(btn);
  }

  root.appendChild(el);
  setTimeout(() => el.remove(), actionLabel ? 20000 : 6000);
}

// Must stay click-driven: navigator.clipboard needs transient activation,
// so writing automatically on load would be rejected.
function offerClipboard(text, message) {
  toast(message, 'Copy conversation', () => navigator.clipboard.writeText(text));
}

function mountUI() {
  const p = getProvider();
  if (!p) return;

  const root = shadow();
  if (root.querySelector('.bar')) return;

  const bar = document.createElement('div');
  bar.className = 'bar';

  const note = document.createElement('input');
  note.type = 'text';
  note.placeholder = 'what to focus on (optional)';
  // These apps bind single-key shortcuts on the document, so a keystroke that
  // escapes this box focuses their composer or opens a panel mid-sentence.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    note.addEventListener(type, (e) => e.stopPropagation());
  }
  bar.appendChild(note);
  bar.append('Send to');

  for (const target of Object.values(PROVIDERS)) {
    if (target.id === p.id) continue;
    const btn = document.createElement('button');
    btn.textContent = target.label;
    btn.addEventListener('click', async () => {
      const r = await handoff(target.id, note.value.trim());
      if (!r.ok) return toast(r.error);
      const opened = window.open(r.url, '_blank', 'noopener');
      if (!opened) toast(`Copied ${r.count} messages.`, `Open ${target.label}`, () => window.open(r.url, '_blank'));
    });
    bar.appendChild(btn);
  }

  root.appendChild(bar);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'handoff') return;
  handoff(msg.target, msg.note).then(sendResponse);
  return true;
});

// ponytail: 2s poll rather than a body MutationObserver -- one getElementById
// per tick, and these SPAs blow the container away on navigation. Swap for an
// observer only if it ever shows up in a profile.
mountUI();
const uiTimer = setInterval(() => {
  // Once orphaned this script can only offer a button that throws, so take the
  // bar away and leave the page to the fresh script on next load.
  if (!alive()) {
    clearInterval(uiTimer);
    document.getElementById('chat-connect-root')?.remove();
    return;
  }
  mountUI();
}, 2000);

consumePending();
