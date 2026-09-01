# Chat Connect

Chrome MV3 extension. Scrapes an in-progress AI conversation and pastes it into a
different provider's composer, so context survives switching between free tiers.
Providers: ChatGPT, Claude, Gemini.

Plain JS/HTML/CSS loaded directly by the manifest. **No build step, no bundler,
no npm dependencies, no framework, no TypeScript.** Keep it that way.

## Layout

| File | Role |
|---|---|
| `content.js` | everything on-page: `PROVIDERS` registry, scrape, handoff, inject, floating button, toast |
| `lib/format.js` | **pure** — no DOM, no `chrome.*`. `toPrompt`, `fitToLimit`. Node-requirable |
| `popup.html` / `popup.js` | toolbar popup |
| `test/format.test.js` | `node test/format.test.js`, plain asserts, no framework |

No service worker: nothing needs to outlive the tab.

## Testing

```
node test/format.test.js     # the only automated check; covers lib/format.js
```

Everything else needs a signed-in browser. `chrome://extensions` → Load unpacked.

**Reloading the extension is not enough.** Content scripts are injected at page
load, so tabs that are already open keep running the previous build with dead
`chrome.*` APIs. After any change: refresh the extension, **then F5 the AI tab**.
Skipping the F5 produces "Extension context invalidated" and silently stages
nothing — a failure that looks exactly like an injection bug. `handoff` now
detects this and says "reload this page", but the discipline still applies.

`consumePending` logs `[Chat Connect] insert {ok, expected, landed, composer}`.
Check that before theorising: `landed` vs `expected` separates a truncated paste
from a failed one, and hovering `composer` highlights the element that was
targeted. This log exists because several fixes were made by guessing from
symptoms and were wrong.

## Invariants worth not rediscovering

**Never hold a composer reference across an `await`.** Gemini re-renders its
composer, detaching the node. A stale node reads back length 0 forever, so every
insert looks failed no matter what is on screen, and a `Range` over it throws
from `addRange`. `insertText` takes *selectors* and re-resolves before each
touch. React reuses nodes, so ChatGPT and Claude tolerate a captured reference;
Gemini's Angular does not. This one masqueraded as four different bugs.

**Never use `document.execCommand('selectAll')`.** It acts on whatever the
document has focused — with focus outside the composer it selects the entire
page and the insert has no editable target. Use an explicit `Range` scoped to
the element (`prepareComposer`).

**Match the visible element.** These apps keep hidden composer copies (Quill's
`.ql-clipboard`, offscreen instances). `findVisible` filters on
`getClientRects()` and tries selectors in priority order.

**Insertion is provider-specific.** `execCommand` for ChatGPT/Claude; Gemini's
Quill keeps only the first line of one, so it sets `pasteFirst` and takes a
synthetic `ClipboardEvent`. Don't make paste the global default: ChatGPT turns a
large paste into a file-attachment chip. Both are always tried, either order.

**Verify by length, not emptiness.** A "non-empty composer" check passed on the
header alone while the conversation was missing. Threshold is 0.5 — the failure
being caught is ~2% landed, so a strict bound only produces false negatives from
whitespace normalisation.

## Where to change things

All provider-specific selectors are the `PROVIDERS` table at the top of
`content.js`. These sites redesign often; **when a transfer breaks, that table is
almost always the whole fix.** A fourth provider is one more entry.

`charLimit` (40000) is a tuning knob, not a hard cap. Lower it for a provider if
a long paste becomes a file-attachment chip. Longer threads truncate
newest-first, always keeping the opening message.

## Deliberately not built

Don't add these back without being asked: a saved-thread library, export UI,
auto-send (it would spend a message on unreviewed text, and the send button's
disabled state is the least stable thing on these pages), accounts, any backend.

An MCP server exposing threads to Cursor/Claude Code is planned for v2 — the
scraped thread is versioned JSON (`v: 1`) as the seam for it.
