/**
 * Self-contained HTML export.
 *
 * Everything is inlined — CSS, and images as data URIs — so the file opens
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

  /**
   * Render a deliberately small Markdown subset. Input must already be escaped.
   * Anything unsupported degrades to plain text rather than being dropped.
   */
  function renderMarkdown(escaped) {
    const blocks = [];
    const fencePattern = /```([\w-]*)\n([\s\S]*?)```/g;
    let cursor = 0;
    let match;

    const inline = (text) =>
      text
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        // Only http(s) links become anchors; javascript: and data: never do.
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');

    const paragraphs = (text) =>
      text
        .split(/\n{2,}/)
        .map((chunk) => {
          const trimmed = chunk.trim();
          if (!trimmed) return '';
          const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
          if (heading) {
            const level = Math.min(heading[1].length + 1, 6);
            return `<h${level}>${inline(heading[2])}</h${level}>`;
          }
          if (/^[-*]\s+/m.test(trimmed) && trimmed.split('\n').every((l) => /^[-*]\s+/.test(l.trim()))) {
            const items = trimmed.split('\n').map((l) => `<li>${inline(l.trim().replace(/^[-*]\s+/, ''))}</li>`);
            return `<ul>${items.join('')}</ul>`;
          }
          return `<p>${inline(trimmed).replace(/\n/g, '<br>')}</p>`;
        })
        .join('\n');

    while ((match = fencePattern.exec(escaped)) !== null) {
      blocks.push(paragraphs(escaped.slice(cursor, match.index)));
      const language = match[1] ? ` data-language="${match[1]}"` : '';
      blocks.push(`<pre${language}><code>${match[2].replace(/\n$/, '')}</code></pre>`);
      cursor = match.index + match[0].length;
    }
    blocks.push(paragraphs(escaped.slice(cursor)));

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
    pre { background:rgba(127,127,127,.12); padding:.85rem 1rem; border-radius:8px; overflow-x:auto; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; }
    pre code { font-size:.85em; }
    img { max-width:100%; height:auto; border-radius:8px; }
    .attachment { display:inline-block; padding:.4rem .7rem; border:1px solid var(--line);
      border-radius:8px; font-size:.85rem; margin:.25rem .25rem .25rem 0; }
    .attachment.missing { opacity:.65; font-style:italic; }
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
    return `<span class="attachment missing">📎 ${name} — not retrievable</span>`;
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

      const media = turn.parts.map((part) => renderPart(part, paths.get(part))).join('\n');
      const body = turn.text ? renderMarkdown(escapeHtml(turn.text)) : '';

      return `<article class="turn ${kind}">
  <header><span>${label}</span>${sub.length ? `<span class="sub">${escapeHtml(sub.join(' · '))}</span>` : ''}</header>
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
    label: 'HTML — self-contained page (.html)',
    extension: 'html',
    mimeType: 'text/html',
    pro: true,
    bundlesAssets: true,
    render,
    escapeHtml,
    renderMarkdown,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
