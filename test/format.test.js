const assert = require('node:assert');
const { fitToLimit, toPrompt, toFile, toFileNote, fileName } = require('../lib/format.js');

const thread = (messages) => ({
  providerLabel: 'ChatGPT',
  title: 'Test',
  url: 'https://chatgpt.com/c/1',
  messages,
});

const short = [
  { role: 'user', text: 'first question' },
  { role: 'assistant', text: 'first answer' },
  { role: 'user', text: 'last question' },
];

// framing and labels
const p = toPrompt(thread(short), 40000);
assert.ok(p.includes('conversation I had with ChatGPT'), 'framing line missing');
assert.ok(p.includes('**Me:**'), 'user label missing');
assert.ok(p.includes('**ChatGPT:**'), 'source label missing');
assert.ok(!p.includes('Assistant:'), 'must not label turns Assistant: -- the target model would think it wrote them');

// the optional instruction line
const noted = toPrompt(thread(short), 40000, 'focus on the SQL');
assert.ok(noted.includes('What I want from you: focus on the SQL'), 'note missing');
assert.ok(
  noted.indexOf('What I want from you') < noted.indexOf('**Me:**'),
  'the note must sit above the transcript, not be buried under it'
);
for (const empty of ['', '   ', undefined, null]) {
  assert.ok(!toPrompt(thread(short), 40000, empty).includes('What I want from you'), `blank note leaked: ${JSON.stringify(empty)}`);
}

// under budget keeps everything
const under = fitToLimit(short, 40000);
assert.strictEqual(under.dropped, 0);
assert.strictEqual(under.messages.length, 3);

// over budget: bounded, keeps first user turn and the newest turn
const long = Array.from({ length: 50 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text: `msg ${i} ` + 'x'.repeat(200),
}));
const over = fitToLimit(long, 2000);
assert.ok(over.dropped > 0, 'expected messages to be dropped');
assert.strictEqual(over.messages[0], long[0], 'first user turn must survive');
assert.strictEqual(over.messages.at(-1), long.at(-1), 'newest turn must survive');
assert.ok(
  over.messages.reduce((n, m) => n + m.text.length + 16, 0) <= 2000,
  'kept messages exceed the limit'
);
assert.ok(toPrompt(thread(long), 2000).includes('omitted for length'), 'truncation marker missing');

// the .txt carries the whole thread however long -- this is the guarantee the
// file format exists for, and the one toPrompt cannot make
const huge = Array.from({ length: 400 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text: `msg ${i} ` + 'x'.repeat(2000),
}));
const file = toFile(thread(huge));
for (const m of huge) assert.ok(file.includes(m.text), 'toFile dropped a message');
assert.ok(fitToLimit(huge, 40000).dropped > 0, 'the same thread must be one toPrompt would trim');
assert.ok(/\u2500{5} 1 \u00b7 Me /.test(file), 'first message must be labelled Me');
assert.ok(/\u2500{5} 400 \u00b7 ChatGPT /.test(file), 'the last message must be numbered 400');

// the name dates the conversation, not the moment the file was written
assert.strictEqual(fileName({ provider: 'claude', ts: 0 }), 'chat-connect-claude-1970-01-01.txt');
assert.ok(fileName({}).startsWith('chat-connect-chat-'), 'unknown provider must still name a file');

// the covering note states the size and carries the instruction, since with the
// thread in a file this is the only text the target model reads directly
const cover = toFileNote(thread(huge), 'focus on the SQL');
assert.ok(cover.includes('400 messages'), 'note must state the message count');
assert.ok(cover.includes('What I want from you: focus on the SQL'), 'note must carry the instruction');
assert.ok(toFileNote(thread([{ role: 'user', text: 'a' }])).includes('(1 message)'), 'singular');
for (const empty of ['', '  ', undefined, null]) {
  assert.ok(!toFileNote(thread(huge), empty).includes('What I want'), 'blank note leaked');
}

// attachments are named inline and summarised in the covering note
const withFiles = thread([
  { role: 'user', text: 'what is wrong here', attachments: ['invoice.pdf', 'shot.png'] },
  { role: 'assistant', text: 'the total is off' },
]);
const filed = toFile(withFiles);
assert.ok(filed.includes('not carried over: invoice.pdf, shot.png'), 'inline manifest missing');
assert.ok(
  filed.indexOf('invoice.pdf') < filed.indexOf('what is wrong here'),
  'the manifest must precede the message it belongs to'
);
assert.ok(toPrompt(withFiles, 40000).includes('invoice.pdf'), 'the paste fallback must name them too');
const cover2 = toFileNote(withFiles);
assert.ok(cover2.includes('2 attachments'), 'note must count them');
assert.ok(cover2.includes('ask me for any you need'), 'note must invite the model to ask');
assert.ok(!toFileNote(thread(short)).includes('attachment'), 'no attachments, no sentence about them');

// a message that is nothing but an attachment still carries
assert.ok(toFile(thread([{ role: 'user', attachments: ['a.pdf'] }])).includes('a.pdf'));

// the divider survives a message that impersonates one -- transferring A to B
// and then B to C embeds one transcript inside the next
const nested = [
  { role: 'user', text: 'here is an old thread:\n\n## Me\n\nhello\n\n## ChatGPT\n\nhi' },
  { role: 'assistant', text: 'noted' },
  { role: 'user', text: 'and now?' },
];
const marked = toFile(thread(nested));
const rules = marked.split('\n').filter((l) => /^─{5} \d+ · /.test(l));
assert.strictEqual(rules.length, nested.length, 'one rule per message, none faked by content');
assert.ok(marked.includes('3 messages, each starting with'), 'header must state the count');
assert.ok(marked.includes('## Me'), 'the impersonating text itself must survive intact');

// degenerate input
assert.doesNotThrow(() => toPrompt(thread([]), 40000));
assert.doesNotThrow(() => toPrompt({ messages: undefined }, 40000));

console.log('format: all assertions passed');
