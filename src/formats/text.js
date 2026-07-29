/**
 * Plain-text formatter. No markup, no delimiters that need escaping — just a
 * readable transcript for pasting into things that reject Markdown.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const RULE = '='.repeat(72);
  const ROLE_LABEL = { user: 'USER', model: 'MODEL', thought: 'MODEL (REASONING)' };

  const fmtDate = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : null);

  function render(conversation, settings) {
    const out = [RULE, conversation.title, RULE, ''];

    out.push(`Exported: ${fmtDate(conversation.exportedAt)}`);
    if (settings.includeSourceUrl && conversation.url) out.push(`Source:   ${conversation.url}`);
    if (settings.includeModelConfig && conversation.config?.model) {
      out.push(`Model:    ${conversation.config.model.replace(/^models\//, '')}`);
    }
    if (settings.includeTokenCounts && conversation.stats.totalTokens !== null) {
      out.push(`Tokens:   ${conversation.stats.totalTokens.toLocaleString('en-US')}`);
    }
    out.push(`Messages: ${conversation.stats.turnCount}`, '');

    if (settings.includeSystemInstruction && conversation.systemInstruction) {
      out.push('-'.repeat(72), 'SYSTEM INSTRUCTION', '-'.repeat(72), '', conversation.systemInstruction, '');
    }

    for (const turn of conversation.turns) {
      const label = ROLE_LABEL[turn.isThought ? 'thought' : turn.role];
      const meta = [];
      if (settings.includeTimestamps && turn.timestamp) meta.push(fmtDate(turn.timestamp));
      if (settings.includeTokenCounts && turn.tokenCount !== null) meta.push(`${turn.tokenCount} tokens`);

      out.push('-'.repeat(72));
      out.push(meta.length ? `${label}  [${meta.join(' | ')}]` : label);
      out.push('-'.repeat(72), '');

      for (const part of turn.parts) {
        const name = part.name || (part.driveId ? `attachment-${part.driveId.slice(0, 8)}` : 'attachment');
        out.push(`[${part.type === 'image' ? 'IMAGE' : 'FILE'}: ${name}]`);
      }
      if (turn.parts.length) out.push('');
      if (turn.text) out.push(turn.text, '');
    }

    return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.text = {
    id: 'text',
    label: 'Plain text (.txt)',
    extension: 'txt',
    mimeType: 'text/plain',
    pro: false,
    bundlesAssets: false,
    render,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
