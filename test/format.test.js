const assert = require('node:assert');
const { fitToLimit, toPrompt, toFile, fileName } = require('../lib/format.js');

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
assert.ok(file.includes('## Me') && file.includes('## ChatGPT'), 'speaker labels missing');

// the name dates the conversation, not the moment the file was written
assert.strictEqual(fileName({ provider: 'claude', ts: 0 }), 'chat-connect-claude-1970-01-01.txt');
assert.ok(fileName({}).startsWith('chat-connect-chat-'), 'unknown provider must still name a file');

// degenerate input
assert.doesNotThrow(() => toPrompt(thread([]), 40000));
assert.doesNotThrow(() => toPrompt({ messages: undefined }, 40000));

console.log('format: all assertions passed');
