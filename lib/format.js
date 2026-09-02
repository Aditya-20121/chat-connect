(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ChatConnectFormat = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Keeps the newest messages plus the first user turn, which nearly always
  // carries the task framing that pure recency would throw away.
  function fitToLimit(messages, limit) {
    const cost = (m) => m.text.length + 16;
    const total = messages.reduce((n, m) => n + cost(m), 0);
    if (total <= limit) return { messages, dropped: 0 };

    const anchor = messages.length && messages[0].role === 'user' ? messages[0] : null;
    let budget = limit - (anchor ? cost(anchor) : 0);

    const tail = [];
    for (let i = messages.length - 1; i >= (anchor ? 1 : 0); i--) {
      budget -= cost(messages[i]);
      if (budget < 0) break;
      tail.unshift(messages[i]);
    }

    const kept = anchor ? [anchor, ...tail] : tail;
    return { messages: kept, dropped: messages.length - kept.length };
  }

  // Named, not carried: the bytes live behind each provider's own storage. A
  // name still tells the target model the context is incomplete, which is the
  // difference between it asking and it inventing.
  const attachLine = (m) =>
    m.attachments && m.attachments.length
      ? `[attached here in the original, not carried over: ${m.attachments.join(', ')}]\n\n`
      : '';

  const allAttachments = (thread) =>
    (thread.messages || []).flatMap((m) => m.attachments || []);

  // Messages were separated by a markdown heading, which a message can trivially
  // contain -- and this extension makes that likely, since transferring A to B
  // and then B to C embeds one transcript inside the next. A numbered rule of
  // box-drawing characters does not occur in ordinary chat text, and the count
  // lets a reader check the boundaries against the total in the header.
  const RULE = '\u2500';
  function divider(i, who) {
    const label = `${RULE.repeat(5)} ${i} · ${who} `;
    return label + RULE.repeat(Math.max(3, 60 - label.length));
  }

  // The whole thread, no limit argument anywhere in sight. This is the format
  // that goes to disk, and later into the composer as an attachment: the point
  // of a file is that nothing has to be dropped to make it fit.
  function toFile(thread) {
    const from = thread.providerLabel || 'another assistant';
    const messages = thread.messages || [];
    const header = [
      `Conversation with ${from}`,
      thread.title || 'Untitled',
      thread.url || '',
      `${messages.length} message${messages.length === 1 ? '' : 's'}, each starting with a ` +
        `${RULE.repeat(5)} n · speaker ${RULE.repeat(5)} rule`,
      '='.repeat(60),
      '',
      '',
    ].join('\n');
    return (
      header +
      messages
        .map((m, i) =>
          `${divider(i + 1, m.role === 'user' ? 'Me' : from)}\n\n${attachLine(m)}${m.text || ''}`
        )
        .join('\n\n')
    );
  }

  // ts, not Date.now(): the name should say when the conversation was taken,
  // which is not when the file happens to be written.
  const fileName = (thread) =>
    `chat-connect-${thread.provider || 'chat'}-` +
    `${new Date(thread.ts ?? Date.now()).toISOString().slice(0, 10)}.txt`;

  // Goes in the composer beside the attachment. With the thread in a file this
  // is the only text the target model reads directly, so the instruction has to
  // live here too, not only in toPrompt.
  function toFileNote(thread, note) {
    const from = thread.providerLabel || 'another assistant';
    const n = (thread.messages || []).length;
    const want = (note || '').trim();
    const files = allAttachments(thread);
    return (
      `I've attached the full conversation I had with ${from} ` +
      `(${n} message${n === 1 ? '' : 's'}) as a text file. Read it for context ` +
      `and continue helping me from where it left off.` +
      // Said out loud in the covering note as well as inline: this is the only
      // text the target model reads directly, and "ask me for them" is the
      // behaviour we want instead of a confident guess.
      (files.length
        ? `\n\nIt also had ${files.length} attachment${files.length === 1 ? '' : 's'} ` +
          `(${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}) that I ` +
          `could not carry over — ask me for any you need.`
        : '') +
      (want ? `\n\nWhat I want from you: ${want}` : '')
    );
  }

  function toPrompt(thread, limit, note) {
    const from = thread.providerLabel || 'another assistant';
    const { messages, dropped } = fitToLimit(thread.messages || [], limit);

    // Trimmed here, not at the call sites: both the bar and the popup reach
    // this, and a blank note must not print an empty instruction.
    const want = (note || '').trim();

    const header =
      `Below is a conversation I had with ${from}. Read it for context and ` +
      `continue helping me from where it left off.\n\n` +
      // The one thing the user says in their own words. It goes above the
      // transcript: after 200 messages of someone else's conversation, a
      // trailing instruction is the easiest part to lose.
      (want ? `What I want from you: ${want}\n\n` : '') +
      `--- ${thread.title || 'Untitled'} (${thread.url || 'no url'}) ---\n\n`;

    const marker = dropped
      ? `_[Earlier ${dropped} message(s) omitted for length.]_\n\n`
      : '';

    const body = messages
      .map((m) => `**${m.role === 'user' ? 'Me' : from}:**\n${attachLine(m)}${m.text || ''}`)
      .join('\n\n');

    return header + marker + body;
  }

  return { fitToLimit, toPrompt, toFile, toFileNote, fileName };
});
