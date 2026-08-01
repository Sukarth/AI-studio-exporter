/**
 * Self-contained HTML export.
 *
 * Everything is inlined: CSS and images as data URIs. So the file opens
 * anywhere with no network and no adjacent folder. Nothing is loaded from a CDN.
 *
 * Message text is escaped before any markup is added, and the small Markdown
 * subset below only ever inserts tags around already-escaped text. That
 * ordering is the whole security argument: a message containing a script tag
 * becomes visible text, never an element. There is no innerHTML of raw model
 * output anywhere in this file.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    if (typeof btoa === 'function') {
      let binary = '';
      // Chunked to avoid blowing the argument limit on large files.
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    }
    return Buffer.from(bytes).toString('base64');
  }

  const inline = (text) =>
    text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // Only http(s) links become anchors; javascript: and data: never do.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');

  /** A `| a | b |` row split into its cells. */
  const tableCells = (line) =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  const isTableRule = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

  /**
   * Line-based block parser over already-escaped text.
   *
   * The previous version split on blank lines and tested each chunk as a whole,
   * so a heading with text on the next line never matched and rendered as
   * literal "## ...". Walking line by line also makes tables possible, which
   * matters more than it sounds: a wide Markdown table left as plain text was
   * what pushed content past the page width.
   */
  function renderBlocks(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;

    const flushParagraph = (buffer) => {
      if (!buffer.length) return;
      out.push(`<p>${inline(buffer.join('\n')).replace(/\n/g, '<br>')}</p>`);
      buffer.length = 0;
    };

    const paragraph = [];
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        flushParagraph(paragraph);
        i++;
        continue;
      }

      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        flushParagraph(paragraph);
        // Shift down one level so a message's own H1 never competes with the
        // conversation title.
        const level = Math.min(heading[1].length + 1, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
        flushParagraph(paragraph);
        out.push('<hr>');
        i++;
        continue;
      }

      // Table: a header row followed by a |---|---| rule.
      if (trimmed.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
        flushParagraph(paragraph);
        const header = tableCells(trimmed);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(tableCells(lines[i]));
          i++;
        }
        const head = header.map((c) => `<th>${inline(c)}</th>`).join('');
        const body = rows
          .map((cells) => `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('');
        out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }

      // Blockquote. `>` is `&gt;` by the time it reaches here.
      if (/^&gt;\s?/.test(trimmed)) {
        flushParagraph(paragraph);
        const quoted = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
          quoted.push(lines[i].trim().replace(/^&gt;\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${renderBlocks(quoted.join('\n'))}</blockquote>`);
        continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
      const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
      if (bullet || numbered) {
        flushParagraph(paragraph);
        const ordered = !!numbered;
        const items = [];
        while (i < lines.length) {
          const t = lines[i].trim();
          const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*+]\s+(.*)$/.exec(t);
          if (!m) break;
          items.push(`<li>${inline(m[1])}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }

      paragraph.push(trimmed);
      i++;
    }
    flushParagraph(paragraph);

    return out.join('\n');
  }

  /**
   * Render a deliberately small Markdown subset. Input must already be escaped.
   * Anything unsupported degrades to plain text rather than being dropped.
   */
  function renderMarkdown(escaped) {
    const blocks = [];
    const fencePattern = /```([\w-]*)\n([\s\S]*?)```/g;
    let cursor = 0;
    let match;

    while ((match = fencePattern.exec(escaped)) !== null) {
      blocks.push(renderBlocks(escaped.slice(cursor, match.index)));
      const language = match[1] ? ` data-language="${match[1]}"` : '';
      blocks.push(`<pre${language}><code>${match[2].replace(/\n$/, '')}</code></pre>`);
      cursor = match.index + match[0].length;
    }
    blocks.push(renderBlocks(escaped.slice(cursor)));

    return blocks.filter(Boolean).join('\n');
  }

  const STYLE = `
    :root { color-scheme: light dark; --bg:#ffffff; --fg:#1a1b1e; --muted:#6b7280;
      --line:#e5e7eb; --user:#eef2ff; --model:#f8fafc; --thought:#fffbeb; --accent:#667eea; }
    @media (prefers-color-scheme: dark) { :root { --bg:#1a1b1e; --fg:#e9ecef; --muted:#9ca3af;
      --line:#2c2e33; --user:#252a45; --model:#212226; --thought:#2a2618; } }
    * { box-sizing: border-box; }
    body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg); line-height:1.65;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
    main { max-width:52rem; margin:0 auto; }
    h1 { font-size:1.75rem; margin:0 0 .5rem; }
    .meta { color:var(--muted); font-size:.85rem; margin-bottom:2rem; border-bottom:1px solid var(--line); padding-bottom:1.5rem; }
    .meta dl { display:grid; grid-template-columns:auto 1fr; gap:.25rem 1rem; margin:.75rem 0 0; }
    .meta dt { font-weight:600; }
    .meta dd { margin:0; }
    .turn { border:1px solid var(--line); border-radius:12px; padding:1rem 1.25rem; margin-bottom:1rem; }
    .turn.user { background:var(--user); }
    .turn.model { background:var(--model); }
    .turn.thought { background:var(--thought); }
    .turn header { display:flex; gap:.75rem; align-items:baseline; margin-bottom:.5rem;
      font-weight:600; font-size:.9rem; }
    .turn header .sub { font-weight:400; color:var(--muted); font-size:.8rem; }
    .turn :first-child { margin-top:0; }
    .turn :last-child { margin-bottom:0; }
    /* A single unbroken line - an ASCII table, a long URL - must not push the
       card past the page. Wrapping is preferable to a clipped message. */
    .turn p, .turn li, .turn td, .turn th, .turn blockquote { overflow-wrap:anywhere; }
    pre { background:rgba(127,127,127,.12); padding:.85rem 1rem; border-radius:8px;
      overflow-x:auto; max-width:100%; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; }
    pre code { font-size:.85em; }
    /* Wide tables scroll inside their own box rather than widening the page. */
    .table-wrap { overflow-x:auto; max-width:100%; margin:.75rem 0; }
    table { border-collapse:collapse; font-size:.9em; }
    th, td { border:1px solid var(--line); padding:.4rem .6rem; text-align:left; vertical-align:top; }
    th { background:rgba(127,127,127,.1); font-weight:600; }
    blockquote { margin:.75rem 0; padding:.1rem 0 .1rem 1rem; border-left:3px solid var(--line);
      color:var(--muted); }
    hr { border:none; border-top:1px solid var(--line); margin:1.25rem 0; }
    h2,h3,h4,h5,h6 { line-height:1.3; margin:1.25rem 0 .5rem; }
    img { max-width:100%; height:auto; border-radius:8px; }
    /* One per line: a row of side-by-side chips is unreadable once filenames
       are long, which they usually are. */
    .attachments { display:flex; flex-direction:column; align-items:flex-start; gap:.35rem;
      margin:0 0 .75rem; }
    .attachment { display:block; max-width:100%; padding:.4rem .7rem; border:1px solid var(--line);
      border-radius:8px; font-size:.85rem; overflow-wrap:anywhere; }
    .attachment.missing { opacity:.65; font-style:italic; }
    /* Reasoning is collapsed by default: it is usually far longer than the
       answer and most readers want the answer. */
    details.thought { border:1px solid var(--line); border-radius:12px; background:var(--thought);
      margin-bottom:1rem; }
    details.thought > summary { cursor:pointer; padding:1rem 1.25rem; font-weight:600;
      font-size:.9rem; list-style:none; display:flex; gap:.75rem; align-items:baseline; }
    details.thought > summary::-webkit-details-marker { display:none; }
    details.thought > summary::before { content:'▸'; color:var(--muted); }
    details.thought[open] > summary::before { content:'▾'; }
    details.thought > summary .sub { font-weight:400; color:var(--muted); font-size:.8rem; }
    details.thought .body { padding:0 1.25rem 1rem; }
    details.thought .body > :first-child { margin-top:0; }
    footer { margin-top:2rem; padding-top:1rem; border-top:1px solid var(--line);
      color:var(--muted); font-size:.8rem; text-align:center; }
    @media print { body { padding:0; } .turn { break-inside:avoid; border-color:#ccc; background:none; } }
  `;

  const fmtDate = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : null);

  function renderPart(part, assetPath) {
    if (part.type === 'image' && part.buffer) {
      const mime = part.mimeType || 'image/png';
      return `<p><img src="data:${escapeHtml(mime)};base64,${toBase64(part.buffer)}" alt="${escapeHtml(part.name || 'image')}"></p>`;
    }
    const name = escapeHtml(part.name || 'attachment');
    if (assetPath) {
      return `<a class="attachment" href="${escapeHtml(encodeURI(assetPath))}">📎 ${name}</a>`;
    }
    return `<span class="attachment missing">📎 ${name}: not retrievable</span>`;
  }

  function render(conversation, settings, assetPaths) {
    const paths = assetPaths || new Map();
    const facts = [];

    if (settings.includeSourceUrl && conversation.url) {
      facts.push(['Source', `<a href="${escapeHtml(conversation.url)}" rel="noopener noreferrer">AI Studio</a>`]);
    }
    const config = conversation.config;
    if (settings.includeModelConfig && config) {
      if (config.model) facts.push(['Model', escapeHtml(config.model.replace(/^models\//, ''))]);
      if (config.temperature !== null) facts.push(['Temperature', config.temperature]);
      if (config.topP !== null) facts.push(['Top P', config.topP]);
      if (config.topK !== null) facts.push(['Top K', config.topK]);
    }
    if (settings.includeTokenCounts && conversation.stats.totalTokens !== null) {
      facts.push(['Total tokens', conversation.stats.totalTokens.toLocaleString('en-US')]);
    }
    facts.push(['Messages', conversation.stats.turnCount]);

    const turns = conversation.turns.map((turn) => {
      const kind = turn.isThought ? 'thought' : turn.role;
      const label = turn.isThought ? '🧠 Model (Reasoning)' : turn.role === 'user' ? '👤 User' : '🤖 Model';
      const sub = [];
      if (settings.includeTimestamps && turn.timestamp) sub.push(fmtDate(turn.timestamp));
      if (settings.includeTokenCounts && turn.tokenCount !== null) sub.push(`${turn.tokenCount} tokens`);
      // Otherwise a message whose only content was an excluded attachment
      // renders as an empty card.
      const excluded = turn.excludedAttachments || 0;
      if (excluded) sub.push(`${excluded} attachment${excluded === 1 ? '' : 's'} not included in export`);

      const images = turn.parts.filter((p) => p.type === 'image' && p.buffer);
      const links = turn.parts.filter((p) => !(p.type === 'image' && p.buffer));
      const media =
        images.map((part) => renderPart(part, paths.get(part))).join('\n') +
        (links.length
          ? `<div class="attachments">${links.map((p) => renderPart(p, paths.get(p))).join('')}</div>`
          : '');
      const body = turn.text ? renderMarkdown(escapeHtml(turn.text)) : '';
      const subHtml = sub.length ? `<span class="sub">${escapeHtml(sub.join(' · '))}</span>` : '';

      // Reasoning collapses; it is usually longer than the answer it precedes.
      if (turn.isThought) {
        return `<details class="thought">
  <summary><span>${label}</span>${subHtml}</summary>
  <div class="body">${media}${body}</div>
</details>`;
      }

      return `<article class="turn ${kind}">
  <header><span>${label}</span>${subHtml}</header>
  ${media}
  ${body}
</article>`;
    });

    const system = settings.includeSystemInstruction && conversation.systemInstruction
      ? `<article class="turn thought"><header><span>⚙️ System Instruction</span></header>${renderMarkdown(escapeHtml(conversation.systemInstruction))}</article>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(conversation.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(conversation.title)}</h1>
<div class="meta">
  Exported ${escapeHtml(fmtDate(conversation.exportedAt))}
  <dl>${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>
</div>
${system}
${turns.join('\n')}
<footer>Exported with AI Studio Exporter</footer>
</main>
</body>
</html>
`;
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.html = {
    id: 'html',
    label: 'HTML: self-contained page (.html)',
    extension: 'html',
    mimeType: 'text/html',
    pro: true,
    bundlesAssets: true,
    render,
    escapeHtml,
    renderMarkdown,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
