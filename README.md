# Chat Connect

Carry an in-progress conversation between ChatGPT, Claude, and Gemini.

You're mid-conversation on ChatGPT, you hit the free-tier wall or want a second
opinion. Click **Send to Claude**. A new tab opens with the whole thread already
pasted into the composer as context. Review it, press Enter, keep going.

No account, no server, no data leaves your browser. The conversation is held in
`chrome.storage.local` for the few seconds between the two tabs, then deleted.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open a conversation on ChatGPT, Claude, or Gemini

Use either the floating **Send to** bar on the page or the toolbar popup.

## How it works

| Step | Where |
|---|---|
| Scrape the open thread | `content.js` → `scrapeThread` |
| Trim to fit the target's composer | `lib/format.js` → `fitToLimit` |
| Format with context framing | `lib/format.js` → `toPrompt` |
| Stage for the target tab | `content.js` → `handoff` |
| Paste on arrival | `content.js` → `consumePending` → `insertText` |

It pastes but never sends. The send button's disabled state is the least stable
thing on these pages, and auto-sending would spend a message from your quota on
text you hadn't read yet.

## Where the selectors live

Everything provider-specific is the `PROVIDERS` table at the top of
[`content.js`](content.js) — message selectors, composer selector, and a
`charLimit`. These sites redesign often, so **when a provider breaks, that table
is the only thing to fix.** Adding a fourth provider is one more entry.

`charLimit` (40000 chars) is a tuning knob, not a hard limit. Lower it for a
provider if a long paste gets converted into a file attachment chip instead of
staying inline. Longer conversations are truncated newest-first, always keeping
the opening message since it usually carries the task framing.

If the paste ever fails — a redesign, or you aren't signed in to the target —
you get a **Copy conversation** button rather than a lost thread.

## Test

```
node test/format.test.js
```

Covers the pure formatting and truncation logic. The scrape and paste paths need
a signed-in browser; see the manual matrix in the plan.

## Status

v0.1.0, works unpacked. Before a Web Store submission it still needs
`icons/icon{16,48,128}.png` and an `icons` key in the manifest.

Not planned for v1: a saved-thread library, auto-send, and an MCP server that
would expose threads to Cursor and Claude Code. The scraped thread is versioned
JSON (`v: 1`) specifically so that last one can be added without a rewrite.
