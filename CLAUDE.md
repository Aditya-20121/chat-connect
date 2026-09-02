# Chat Connect

Chrome MV3 extension. Scrapes an in-progress AI conversation and pastes it into a
different provider's composer. Providers: ChatGPT, Claude, Gemini.

Plain JS/HTML/CSS loaded directly by the manifest. **No build step, no bundler,
no npm dependencies, no framework, no TypeScript.** Keep it that way.

## Layout

| File | Role |
|---|---|
| `content.js` | everything on-page: `PROVIDERS` registry, scrape, handoff, inject, floating button, toast |
| `lib/format.js` | **pure** — no DOM, no `chrome.*`. `toPrompt`, `toFile`, `toFileNote`, `fitToLimit`. Node-requirable |
| `popup.html` / `popup.js` | toolbar popup |
| `test/format.test.js` | `node test/format.test.js`, plain asserts, no framework |

No service worker: nothing needs to outlive the tab.

## Testing

```
node test/format.test.js     # the only automated check; covers lib/format.js
```

Everything else needs a signed-in browser. `chrome://extensions` → Load unpacked.
Content scripts are injected at page load, so after reloading the extension the
AI tab needs a refresh too.

`consumePending` logs `[Chat Connect] insert {ok, expected, landed, composer}`.
`landed` vs `expected` separates a truncated paste from a failed one; hovering
`composer` highlights the element that was targeted.

## Invariants

**Never hold a composer reference across an `await`.** Gemini re-renders its
composer, detaching the node: a stale node reads back length 0 forever, and a
`Range` over it throws from `addRange`. `insertText` takes *selectors* and
re-resolves before each touch.

**Never use `document.execCommand('selectAll')`.** It acts on whatever the
document has focused, so with focus outside the composer it selects the whole
page. Use an explicit `Range` scoped to the element (`prepareComposer`).

**Match the visible element.** These apps keep hidden composer copies (Quill's
`.ql-clipboard`, offscreen instances). `findVisible` filters on
`getClientRects()` and tries selectors in priority order.

**A failed upload check is not a failed upload.** `attachFile` is the only
non-idempotent thing here -- every strategy uploads for real -- so a strategy
that worked but could not be verified costs a duplicate attachment. Each is
tried at most once, and each reports whether the app *consumed* the file
(an input the app cleared, an event it called `preventDefault` on) separately
from whether its chip is visible. Either signal stops the loop. ChatGPT renames
uploads to a UUID, so its chip is never findable by name: it is pinned to
`attach: ['paste']` rather than left to fall through and attach twice.

**Insertion is provider-specific.** `execCommand` for ChatGPT/Claude; Gemini's
Quill keeps only the first line of one, so it sets `pasteFirst` and takes a
synthetic `ClipboardEvent`. Paste is not the global default because ChatGPT
turns a large paste into a file-attachment chip. Both are tried, either order.

**Verify by length, not emptiness.** Threshold is 0.5 of expected — a header
alone passes an emptiness check while the conversation is missing.

## Where to change things

All provider-specific selectors are the `PROVIDERS` table at the top of
`content.js`. These sites redesign often; **when a transfer breaks, that table is
almost always the whole fix.** A fourth provider is one more entry.

Every thread transfers as a `.txt` attachment plus a short covering note, so
nothing is trimmed to fit a composer. The inline paste is the fallback for a
provider whose upload path cannot be driven, and `charLimit` (40000) bounds only
that path -- `fitToLimit` truncates newest-first there, always keeping the
opening message.

## Deliberately not built

Don't add these back without being asked: a saved-thread library, export UI,
auto-send (it would spend a message on unreviewed text), accounts, any backend.

An MCP server exposing threads to Cursor/Claude Code is planned for v2 — the
scraped thread is versioned JSON (`v: 1`) as the seam for it.
