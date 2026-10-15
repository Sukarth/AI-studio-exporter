/**
 * JSONL export for fine-tuning.
 *
 * One JSON object per line in the messages format every major training stack
 * accepts. Reasoning turns are dropped by default rather than folded into the
 * assistant message: training on a model's private thinking as if it were the
 * reply teaches it to emit thinking as output. `includeReasoning` opts back in
 * for callers who genuinely want reasoning traces.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const ROLE_MAP = { user: 'user', model: 'assistant' };

  /**
   * Consecutive same-role turns must be merged: a conversation that alternates
   * user/user or assistant/assistant is rejected by most fine-tuning APIs.
   */
  function toMessages(conversation, options) {
    const messages = [];

    if (conversation.systemInstruction) {
      messages.push({ role: 'system', content: conversation.systemInstruction });
    }

    for (const turn of conversation.turns) {
      if (turn.isThought && !options.includeReasoning) continue;

      const role = ROLE_MAP[turn.role] || 'user';
      const attachmentNote = turn.parts
        .filter((part) => part.name)
        .map((part) => `[attachment: ${part.name}]`)
        .join('\n');

      const content = [attachmentNote, turn.text].filter(Boolean).join('\n\n');
      if (!content) continue;

      const previous = messages[messages.length - 1];
      if (previous && previous.role === role) previous.content += `\n\n${content}`;
      else messages.push({ role, content });
    }

    return messages;
  }

  function render(conversation, settings) {
    const messages = toMessages(conversation, {
      includeReasoning: !!settings.jsonlIncludeReasoning,
    });

    // A conversation that never got a reply is not a training example.
    if (!messages.some((m) => m.role === 'assistant')) return '';

    return JSON.stringify({ messages }) + '\n';
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.jsonl = {
    id: 'jsonl',
    label: 'JSONL: fine-tuning (.jsonl)',
    extension: 'jsonl',
    mimeType: 'application/jsonl',
    pro: true,
    bundlesAssets: false,
    // Batch export concatenates these into a single dataset file rather than
    // writing one file per conversation.
    concatenable: true,
    render,
    toMessages,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
