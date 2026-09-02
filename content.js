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
    // Only paste. ChatGPT renames an attachment to a UUID, so the filename
    // check cannot see its own upload -- with a second strategy to fall to,
    // that read as failure and attached the conversation twice.
    attach: ['paste'],
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

// The rendered chip is the only generic sign an upload was accepted -- there is
// no common event for it. Matched as a prefix because these apps middle-truncate
// long filenames in the chip.
const FILE_TAG = 'chat-connect';

// An input restricted to images rejects a .txt silently, costing a full timeout
// to discover. An empty accept means anything.
function takesText(input) {
  const accept = (input.accept || '').toLowerCase().trim();
  return !accept || accept.includes('*/*') || accept.includes('text/plain') || accept.includes('.txt');
}

// Every one of these apps attaches through a hidden <input type="file">, and
// assigning input.files drives the app's own upload path -- its request, its
// progress state, its chip. A synthetic paste or drop is a guess at each app's
// own handler by comparison, so those come second.
// Every strategy here uploads for real, so a strategy that worked but could not
// be verified costs a duplicate attachment. Each is tried at most once, and a
// provider that renames what it receives is pinned to a single strategy in
// PROVIDERS rather than left to fall through the list.
const ATTACH = ['input', 'paste', 'drop'];

async function attachFile(selectors, name, text, strategies = ATTACH) {
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: 'text/plain' }));
  // textContent, not innerText: this is polled, and innerText forces a layout
  // every tick.
  const attached = () => document.body.textContent.includes(FILE_TAG);

  for (const how of strategies) {
    // Whether the app took the file, independently of whether we can see its
    // chip. Not seeing a chip is a weak signal -- a provider may rename the
    // file, or render it somewhere this cannot read -- and acting on it by
    // trying the next strategy uploads the conversation a second time.
    let consumed = () => false;

    // Re-resolve every time: an upload takes seconds and these composers
    // re-render underneath it.
    if (how === 'input') {
      // The first usable one only. A second input is a second real upload.
      const input = [...document.querySelectorAll('input[type="file"]')].find(takesText);
      if (!input) continue;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // An app that handled the upload clears its input, so the same file can
      // be picked again; one still holding ours had no listener behind it.
      consumed = () => input.files.length === 0;
    } else {
      const el = findVisible(selectors);
      if (!el) continue;
      el.focus();
      // dispatchEvent returns false once a handler has called preventDefault:
      // proof the app claimed the event, chip or no chip.
      const took = !el.dispatchEvent(
        how === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
      consumed = () => took;
    }

    if (await waitUntil(attached, 5000, 150)) {
      console.log('[Chat Connect] attach', { how, name });
      return true;
    }
    if (consumed()) {
      // Uploaded but unverified. Stopping here risks a note about a file that
      // never arrived; carrying on risks attaching the thread twice, and a
      // duplicate is the worse of the two to be left holding.
      console.log('[Chat Connect] attach unverified', { how, name });
      return true;
    }
  }

  console.log('[Chat Connect] attach failed', { name, tried: strategies });
  return false;
}

// What the PROVIDERS entry currently matches on this page. These sites
// redesign often, and every failure otherwise reads as the same unhelpful
// "could not read this conversation".
function health(p) {
  return {
    provider: p.id,
    user: document.querySelectorAll(p.user.sel).length,
    bot: document.querySelectorAll(p.bot.sel).length,
    composer: p.composerSel.find((sel) => findVisible([sel])) || null,
    fileInputs: document.querySelectorAll('input[type="file"]').length,
    attach: p.attach || ATTACH,
  };
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
    // Which selector went stale is the whole diagnosis, and these sites
    // redesign often enough that it is worth saying out loud. Logged rather
    // than rendered: it means nothing to whoever is just trying to send a
    // conversation.
    const h = health(p);
    console.log('[Chat Connect] health', h);
    return {
      ok: false,
      error: h.user + h.bot === 0
        ? `Could not read this ${p.label} conversation — its layout has probably changed.`
        : 'Could not read this conversation.',
    };
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

  // The file first: it carries the entire thread, where the inline paste is
  // capped by charLimit. The paste stays as the fallback for a provider whose
  // upload path we cannot drive.
  const file = ChatConnectFormat.toFile(pending.thread);
  if (await attachFile(p.composerSel, ChatConnectFormat.fileName(pending.thread), file, p.attach)) {
    const note = ChatConnectFormat.toFileNote(pending.thread, pending.note);
    if (await insertText(p.composerSel, note, p.pasteFirst)) {
      return toast(`Full ${pending.thread.providerLabel} conversation attached — review it, then press Enter.`);
    }
    // The file is on the composer either way; only the covering note is missing.
    return toast(`Conversation attached to ${p.label} — add a line of your own, then press Enter.`);
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
  /* Eases the snap back from the edge; off during a drag, where it would lag
     the pointer. */
  .bar { transition: left .15s ease, top .15s ease; }
  .bar.dragging { transition: none; }
  .grip {
    cursor: grab; padding: 0 2px; color: #52525b; font-size: 14px;
    line-height: 1; user-select: none;
  }
  .bar.dragging .grip { cursor: grabbing; }
  .bar .hide { padding: 5px 8px; color: #a1a1aa; background: transparent; }
  .tab {
    /* right, always: a fixed element with no horizontal anchor falls back to
       its static position, which put the collapsed tab on the left. */
    position: fixed; right: 0; z-index: 2147483647; cursor: pointer;
    padding: 10px 5px; border: 1px solid #3f3f46; border-right: none;
    border-radius: 8px 0 0 8px; background: #18181b; color: #a1a1aa;
    font: 600 10px system-ui, sans-serif; letter-spacing: .08em;
    writing-mode: vertical-rl;
  }
  .tab:hover { color: #fafafa; background: #27272a; }
  /* Without this a touch drag scrolls the page instead of moving the bar. */
  .bar, .tab { touch-action: none; }
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

// A detached anchor is enough for a download in Chrome, and the object URL is
// revoked on a timer rather than straight after click -- revoking synchronously
// races the download and can cancel it.
function saveThread(p) {
  const thread = scrapeThread(p);
  if (!thread.messages.length) return toast('Could not read this conversation.');

  const url = URL.createObjectURL(
    new Blob([ChatConnectFormat.toFile(thread)], { type: 'text/plain' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = ChatConnectFormat.fileName(thread);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${thread.messages.length} messages as ${a.download}`);
}

const UI_KEY = 'ui';
// x/y null means "wherever the stylesheet puts it". Kept in a module variable
// as well as storage because the SPA blows the container away on navigation and
// the bar is rebuilt synchronously, with no time to await a read.
let ui = { x: null, y: null, hidden: false };
// Survives a rebuild too -- losing what you typed because you collapsed the bar
// would be its own small betrayal.
let noteText = '';

async function loadUI() {
  if (!alive()) return;
  try {
    const stored = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
    if (stored) ui = { ...ui, ...stored };
  } catch {}
}

function saveUI() {
  if (!alive()) return;
  chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
}

const clamp = (n, max) => Math.max(0, Math.min(n, max));

// Re-clamped on every placement, not just on drop: a window resized smaller
// since the position was saved would otherwise strand the bar off-screen with
// no way to get it back.
//
// While dragging the right edge is open, so the bar slides off the screen
// instead of stopping dead against it. Anything still on screen at drop is
// pulled back in; a bar pushed far enough past the edge is taken as put away.
function place(el, dragging) {
  if (ui.x == null) return;
  const { width, height } = el.getBoundingClientRect();
  ui.x = clamp(ui.x, dragging ? window.innerWidth : window.innerWidth - width);
  ui.y = clamp(ui.y, window.innerHeight - height);
  Object.assign(el.style, { left: `${ui.x}px`, top: `${ui.y}px`, right: 'auto', bottom: 'auto' });
}

function draggable(el) {
  el.addEventListener('pointerdown', (e) => {
    // The controls are the point of the bar; only the space around them drags.
    if (e.target.closest('button, input')) return;
    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');

    const move = (ev) => {
      ui.x = ev.clientX - offsetX;
      ui.y = ev.clientY - offsetY;
      place(el, true);
    };
    const drop = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('dragging');
      // A third of the way off the edge is a decision, not a slip: collapse
      // rather than snapping it back and undoing what was just done.
      if (ui.x + rect.width - window.innerWidth > rect.width / 3) {
        ui.hidden = true;
        saveUI();
        return mountUI();
      }
      place(el);
      saveUI();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', drop, { once: true });
    el.addEventListener('pointercancel', drop, { once: true });
    // Otherwise the drag selects the page text underneath it.
    e.preventDefault();
  });
}

function mountUI() {
  const p = getProvider();
  if (!p) return;

  const root = shadow();
  if (root.querySelector(ui.hidden ? '.tab' : '.bar')) return;
  root.querySelector('.bar, .tab')?.remove();

  const rerender = () => {
    saveUI();
    mountUI();
  };

  if (ui.hidden) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.textContent = 'SEND';
    tab.title = 'Show Chat Connect';
    // The tab keeps the bar's own vertical position, so it reappears where it
    // was put rather than jumping back to a default corner.
    tab.style.top = ui.y == null ? '' : `${ui.y}px`;
    tab.style.bottom = ui.y == null ? '96px' : 'auto';
    // Both a button and a handle. A press that never really moved is a click
    // to reopen; anything more is a drag along the edge, and must not reopen
    // the bar on release.
    tab.addEventListener('pointerdown', (e) => {
      const offsetY = e.clientY - tab.getBoundingClientRect().top;
      let moved = false;
      tab.setPointerCapture(e.pointerId);

      const move = (ev) => {
        if (Math.abs(ev.clientY - e.clientY) > 3) moved = true;
        if (!moved) return;
        ui.y = clamp(ev.clientY - offsetY, window.innerHeight - tab.offsetHeight);
        Object.assign(tab.style, { top: `${ui.y}px`, bottom: 'auto' });
      };
      const up = () => {
        tab.removeEventListener('pointermove', move);
        if (moved) return saveUI();
        ui.hidden = false;
        rerender();
      };

      tab.addEventListener('pointermove', move);
      tab.addEventListener('pointerup', up, { once: true });
      tab.addEventListener('pointercancel', up, { once: true });
      e.preventDefault();
    });
    root.appendChild(tab);
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'bar';

  const grip = document.createElement('span');
  grip.className = 'grip';
  grip.textContent = '⠿';
  grip.title = 'Drag to move';
  bar.appendChild(grip);

  const note = document.createElement('input');
  note.type = 'text';
  note.placeholder = 'what to focus on (optional)';
  note.value = noteText;
  note.addEventListener('input', () => (noteText = note.value));
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

  const save = document.createElement('button');
  save.textContent = '.txt';
  save.title = 'Download the whole conversation as a text file';
  save.addEventListener('click', () => saveThread(p));
  bar.appendChild(save);

  const hide = document.createElement('button');
  hide.className = 'hide';
  hide.textContent = '×';
  hide.title = 'Collapse to the edge';
  hide.addEventListener('click', () => {
    ui.hidden = true;
    rerender();
  });
  bar.appendChild(hide);

  root.appendChild(bar);
  place(bar);
  draggable(bar);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'handoff') return;
  handoff(msg.target, msg.note).then(sendResponse);
  return true;
});

// ponytail: 2s poll rather than a body MutationObserver -- one getElementById
// per tick, and these SPAs blow the container away on navigation. Swap for an
// observer only if it ever shows up in a profile.
loadUI().then(mountUI);
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
