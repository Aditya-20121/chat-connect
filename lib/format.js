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

  // The whole thread, no limit argument anywhere in sight. This is the format
  // that goes to disk, and later into the composer as an attachment: the point
  // of a file is that nothing has to be dropped to make it fit.
  function toFile(thread) {
    const from = thread.providerLabel || 'another assistant';
    const header = [
      `Conversation with ${from}`,
      thread.title || 'Untitled',
      thread.url || '',
      '='.repeat(60),
      '',
      '',
    ].join('\n');
    return (
      header +
      (thread.messages || [])
        .map((m) => `## ${m.role === 'user' ? 'Me' : from}\n\n${m.text}`)
        .join('\n\n')
    );
  }

  // ts, not Date.now(): the name should say when the conversation was taken,
  // which is not when the file happens to be written.
  const fileName = (thread) =>
    `chat-connect-${thread.provider || 'chat'}-` +
    `${new Date(thread.ts ?? Date.now()).toISOString().slice(0, 10)}.txt`;

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
      .map((m) => `**${m.role === 'user' ? 'Me' : from}:**\n${m.text}`)
      .join('\n\n');

    return header + marker + body;
  }

  return { fitToLimit, toPrompt, toFile, fileName };
});
