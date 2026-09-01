(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ChatConnectFormat = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function messagesToMarkdown(thread) {
    const title = thread.title || 'Untitled conversation';
    const header = `# ${title}\n\nSource: ${thread.provider} — ${thread.url}\n\n---\n\n`;
    const body = (thread.messages || [])
      .map((m) => `**${m.role === 'user' ? 'You' : 'Assistant'}:**\n\n${m.text}\n`)
      .join('\n---\n\n');
    return header + body;
  }

  return { messagesToMarkdown };
});
