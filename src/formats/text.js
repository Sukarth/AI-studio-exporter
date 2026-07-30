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

  /**
   * @param {Object} conversation
   * @param {Object} settings
   * @param {Map<Object, string>} assetPaths - part -> path within the archive
   */
  function render(conversation, settings, assetPaths) {
    const paths = assetPaths || new Map();
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
      const excluded = turn.excludedAttachments || 0;
      if (excluded) meta.push(`${excluded} attachment${excluded === 1 ? '' : 's'} not included in export`);

      out.push('-'.repeat(72));
      out.push(meta.length ? `${label}  [${meta.join(' | ')}]` : label);
      out.push('-'.repeat(72), '');

      for (const part of turn.parts) {
        const name = part.name || (part.driveId ? `attachment-${part.driveId.slice(0, 8)}` : 'attachment');
        const kind = part.type === 'image' ? 'IMAGE' : 'FILE';
        const at = paths.get(part);
        out.push(at ? `[${kind}: ${name} -> ${at}]` : `[${kind}: ${name}]`);
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
    // A transcript that names its attachments but does not ship them is not a
    // complete export, and the ZIP is only built when there is something to put
    // in it — a plain conversation still downloads as a bare .txt.
    bundlesAssets: true,
    render,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
