# Contributing

There is no build step. Clone it, load it unpacked, edit a file, reload.

```
git clone https://github.com/Aditya-20121/chat-connect
node test/format.test.js          # the only automated check
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → pick the folder.
Content scripts are injected at page load, so after reloading the extension the
AI tab needs a refresh too.

**Please keep it dependency-free.** Plain JS, HTML and CSS loaded directly by the
manifest — no bundler, no npm, no framework, no TypeScript. A pull request that
adds a build step will be declined however good the code is.

## Adding a provider

This is the most useful contribution you can make, and it needs no
understanding of the insertion code. A provider is one entry in the `PROVIDERS`
table at the top of [`content.js`](content.js):

```js
grok: {
  id: 'grok',
  label: 'Grok',
  newUrl: 'https://grok.com/',
  hosts: ['grok.com'],
  user: { sel: '[data-message-role="user"]' },
  bot: { sel: '[data-message-role="assistant"]' },
  composerSel: ['textarea[aria-label="Ask Grok anything"]'],
  charLimit: 40000,
},
```

| Field | What it is |
|---|---|
| `id` | must match the key |
| `label` | shown on the buttons — how the site calls itself |
| `newUrl` | where a fresh conversation starts |
| `hosts` | every hostname the app is served from |
| `user` / `bot` | `sel` finds a message; optional `textSel` narrows to the text inside it, when the message wrapper also holds toolbars or citations |
| `composerSel` | the input box, **in priority order** — the first one that is visible wins |
| `charLimit` | when the inline paste fallback starts dropping older messages |
| `attach` | optional. Which upload strategies to try, in order: `['input', 'paste', 'drop']` is the default. Pin it to one if the provider renames what it receives — see below |
| `pasteFirst` | optional. Set it if `execCommand` mangles inserts, as Quill does |

**Also add the provider to [`popup.js`](popup.js)**, which keeps its own smaller
copy of the table (`label` and `hosts` only). The popup runs in a different
context and can't import from the content script. Forgetting this is the most
common mistake — the floating bar will work and the toolbar popup won't.

### Finding the selectors

Open a conversation, inspect a message, and look for a stable attribute —
`data-message-author-role`, `data-testid`, a custom element name. Avoid
generated class names; they change weekly.

To check your work, open a conversation and make the scrape fail (transfer from
an empty chat). The console prints what your entry currently matches:

```
[Chat Connect] health { provider: 'grok', user: 14, bot: 13, composer: '…', fileInputs: 1, attach: [...] }
```

`user` and `bot` should match the number of messages you can see. `composer`
should be the selector that matched, not `null`.

### The upload strategy

Transfers go over as a `.txt` attachment. `attachFile` verifies success by
looking for the filename in the page, so a provider that **renames** uploads
can never be verified that way, and must be pinned to a single strategy —
otherwise it uploads the conversation once per strategy. ChatGPT is pinned to
`['paste']` for exactly this reason. If your provider attaches the file twice,
that's why.

## Fixing a broken transfer

These sites redesign often. Almost every breakage is one stale selector, and
almost every fix is one line in `PROVIDERS`. Start there before reading
anything else. Include the `health` output in the issue or pull request.

## What this project won't take

Not out of principle so much as scope — please open an issue before building
any of these:

- **Auto-send.** It would spend a message from your quota on text you hadn't
  read, which is the exact quota that made you reach for this in the first place.
- **A backend, accounts, or telemetry.** Nothing leaves the browser, and that is
  the whole pitch.
- **A saved-thread library or export UI.** The download button covers the need.

## Style

Match what's there. Comments explain *why* a line is the way it is —
particularly where something obvious was tried first and didn't work. The
invariants in [`CLAUDE.md`](CLAUDE.md) are all scars; read them before changing
the insertion or attachment paths.
