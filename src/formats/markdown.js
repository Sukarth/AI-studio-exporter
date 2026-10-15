/**
 * Markdown formatter.
 *
 * Message bodies are written verbatim, never escaped: what AI Studio returns is
 * already Markdown and mangling it would defeat the point of the export. The
 * cost is that a message can contain text resembling our own section headings.
 * We solve that with HTML comment delimiters (`<!-- aise:turn ... -->`) which
 * render as nothing but give both humans and re-import tooling an unambiguous
 * boundary that message content cannot forge without trying to.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const ROLE_HEADING = { user: '## User', model: '## Model', thought: '## Model (Reasoning)' };

  const fmtDate = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : null);

  /** Safe inside a Markdown link/image label. */
  const escapeLabel = (s) => String(s || '').replace(/([[\]])/g, '\\$1');

  /**
   * Safe inside a Markdown link target.
   *
   * encodeURI leaves parentheses alone, which is fine for a URL and wrong for
   * Markdown: a parser ends the target at the first `)`. That matters because
   * colliding attachment names are disambiguated with a " (2)" suffix, so any
   * conversation with two files of the same name produced broken links; found
   * on a real export where 12 of 42 links pointed at nothing.
   *
   * `#` would start a fragment and `?` a query, so those go too.
   */
  const escapeTarget = (s) =>
    encodeURI(String(s || ''))
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');

  function renderFrontMatter(conversation, settings) {
    const lines = [`# ${conversation.title}`, ''];
    const facts = [];

    facts.push(['Exported', fmtDate(conversation.exportedAt)]);
    if (settings.includeTimestamps && conversation.modifiedAt) {
      facts.push(['Last modified', fmtDate(conversation.modifiedAt)]);
    }
    if (settings.includeSourceUrl && conversation.url) {
      facts.push(['Source', conversation.url]);
    }

    const config = conversation.config;
    if (settings.includeModelConfig && config) {
      if (config.model) facts.push(['Model', config.model.replace(/^models\//, '')]);
      if (config.temperature !== null) facts.push(['Temperature', config.temperature]);
      if (config.topP !== null) facts.push(['Top P', config.topP]);
      if (config.topK !== null) facts.push(['Top K', config.topK]);
      if (config.maxOutputTokens !== null) facts.push(['Max output tokens', config.maxOutputTokens]);
    }

    if (settings.includeTokenCounts && conversation.stats.totalTokens !== null) {
      facts.push(['Total tokens', conversation.stats.totalTokens.toLocaleString('en-US')]);
    }
    facts.push(['Messages', conversation.stats.turnCount]);

    if (conversation.source === 'dom') {
      facts.push(['Note', 'Exported via page scraping: some metadata unavailable']);
    }

    for (const [key, value] of facts) {
      if (value !== null && value !== undefined && value !== '') lines.push(`**${key}:** ${value}  `);
    }

    if (settings.includeSystemInstruction && conversation.systemInstruction) {
      lines.push('', '### System Instruction', '', '> ' + conversation.systemInstruction.split('\n').join('\n> '));
    }

    lines.push('', '---', '');
    return lines.join('\n');
  }

  function renderPart(part, assetPath) {
    if (part.type === 'image' && assetPath) {
      return `![${escapeLabel(part.name || 'image')}](${escapeTarget(assetPath)})`;
    }
    const name = part.name || (part.driveId ? `attachment-${part.driveId.slice(0, 8)}` : 'attachment');
    const size = part.byteLength ? ` _(${formatBytes(part.byteLength)})_` : '';
    // The "Attachment:" prefix is what tells a reader this link points at a
    // bundled file rather than out at the web. It used to be a paperclip.
    if (assetPath) return `**Attachment:** [${escapeLabel(name)}](${escapeTarget(assetPath)})${size}`;
    // No bytes retrieved; record that something was attached rather than
    // silently dropping it, so the export stays an honest record.
    return `**Attachment:** ${escapeLabel(name)}${size} _(file not retrievable)_`;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /**
   * @param {Object} conversation - normalized model
   * @param {Object} settings
   * @param {Map<Object, string>} assetPaths - part -> path within the archive
   */
  function render(conversation, settings, assetPaths) {
    const out = [renderFrontMatter(conversation, settings)];
    const paths = assetPaths || new Map();

    for (const turn of conversation.turns) {
      const kind = turn.isThought ? 'thought' : turn.role;
      out.push(`<!-- aise:turn role=${turn.role}${turn.isThought ? ' thought=1' : ''} -->`);
      out.push(ROLE_HEADING[kind]);

      const meta = [];
      if (settings.includeTimestamps && turn.timestamp) meta.push(fmtDate(turn.timestamp));
      if (settings.includeTokenCounts && turn.tokenCount !== null) {
        meta.push(`${turn.tokenCount.toLocaleString('en-US')} tokens`);
      }
      // Without this, a message whose only content was an attachment the user
      // opted out of renders as a bare heading; indistinguishable from a bug.
      const excluded = turn.excludedAttachments || 0;
      if (excluded) {
        meta.push(`${excluded} attachment${excluded === 1 ? '' : 's'} not included in export`);
      }
      if (meta.length) out.push('', `_${meta.join(' · ')}_`);

      out.push('');
      for (const part of turn.parts) out.push(renderPart(part, paths.get(part)), '');
      if (turn.text) out.push(turn.text, '');
    }

    return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.markdown = {
    id: 'markdown',
    label: 'Markdown (.md)',
    extension: 'md',
    mimeType: 'text/markdown',
    pro: false,
    bundlesAssets: true,
    render,
    // Shared with the library index, which is Markdown and has the same
    // collision suffixes in its paths.
    escapeTarget,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
