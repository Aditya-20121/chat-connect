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

  function toPrompt(thread, limit) {
    const from = thread.providerLabel || 'another assistant';
    const { messages, dropped } = fitToLimit(thread.messages || [], limit);

    const header =
      `Below is a conversation I had with ${from}. Read it for context and ` +
      `continue helping me from where it left off.\n\n` +
      `--- ${thread.title || 'Untitled'} (${thread.url || 'no url'}) ---\n\n`;

    const marker = dropped
      ? `_[Earlier ${dropped} message(s) omitted for length.]_\n\n`
      : '';

    const body = messages
      .map((m) => `**${m.role === 'user' ? 'Me' : from}:**\n${m.text}`)
      .join('\n\n');

    return header + marker + body;
  }

  return { fitToLimit, toPrompt };
});
