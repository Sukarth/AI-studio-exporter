/**
 * Obsidian-flavoured Markdown.
 *
 * Differs from the plain Markdown export in three ways that matter inside a
 * vault: YAML frontmatter so notes are queryable by Dataview, `![[wikilinks]]`
 * for attachments so they resolve as vault files, and reasoning inside a
 * collapsible callout so long thinking does not bury the answer.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  /**
   * Quote a YAML scalar. Frontmatter is the one place where an unescaped title
   * breaks the whole note rather than just looking wrong, so quote defensively
   * and always.
   */
  function yamlString(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
  }

  const isoOrNull = (ms) => (ms ? new Date(ms).toISOString() : null);

  function renderFrontMatter(conversation, settings) {
    const fields = [
      ['title', yamlString(conversation.title)],
      ['exported', isoOrNull(conversation.exportedAt)],
    ];

    if (settings.includeTimestamps && conversation.modifiedAt) {
      fields.push(['modified', isoOrNull(conversation.modifiedAt)]);
    }
    if (settings.includeSourceUrl && conversation.url) fields.push(['source', conversation.url]);

    const config = conversation.config;
    if (settings.includeModelConfig && config) {
      if (config.model) fields.push(['model', yamlString(config.model.replace(/^models\//, ''))]);
      if (config.temperature !== null) fields.push(['temperature', config.temperature]);
      if (config.topP !== null) fields.push(['top_p', config.topP]);
      if (config.topK !== null) fields.push(['top_k', config.topK]);
    }
    if (settings.includeTokenCounts && conversation.stats.totalTokens !== null) {
      fields.push(['total_tokens', conversation.stats.totalTokens]);
    }
    fields.push(['messages', conversation.stats.turnCount]);
    fields.push(['tags', '[ai-studio, conversation]']);

    const lines = fields
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);

    return ['---', ...lines, '---', ''].join('\n');
  }

  function renderPart(part, assetPath) {
    const name = part.name || 'attachment';
    if (!assetPath) return `> [!missing] Attachment unavailable: ${name}`;
    // Wikilinks resolve by vault filename, so link the basename rather than the
    // archive-relative path.
    const basename = assetPath.split('/').pop();
    return part.type === 'image' ? `![[${basename}]]` : `**Attachment:** [[${basename}]]`;
  }

  function render(conversation, settings, assetPaths) {
    const paths = assetPaths || new Map();
    const out = [renderFrontMatter(conversation, settings)];

    if (settings.includeSystemInstruction && conversation.systemInstruction) {
      out.push('> [!abstract]- System Instruction');
      out.push('> ' + conversation.systemInstruction.split('\n').join('\n> '), '');
    }

    for (const turn of conversation.turns) {
      if (turn.isThought) {
        // Collapsed by default: reasoning is usually longer than the answer.
        out.push('> [!note]- Reasoning');
        out.push('> ' + turn.text.split('\n').join('\n> '), '');
        continue;
      }

      out.push(turn.role === 'user' ? '## User' : '## Model');

      const meta = [];
      if (settings.includeTimestamps && turn.timestamp) meta.push(new Date(turn.timestamp).toISOString());
      if (settings.includeTokenCounts && turn.tokenCount !== null) meta.push(`${turn.tokenCount} tokens`);
      const excluded = turn.excludedAttachments || 0;
      if (excluded) meta.push(`${excluded} attachment${excluded === 1 ? '' : 's'} not included in export`);
      if (meta.length) out.push('', `*${meta.join(' · ')}*`);

      out.push('');
      for (const part of turn.parts) out.push(renderPart(part, paths.get(part)), '');
      if (turn.text) out.push(turn.text, '');
    }

    return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.obsidian = {
    id: 'obsidian',
    label: 'Obsidian Markdown (.md)',
    extension: 'md',
    mimeType: 'text/markdown',
    pro: true,
    bundlesAssets: true,
    render,
    yamlString,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
