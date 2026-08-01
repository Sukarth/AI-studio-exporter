/**
 * DOCX and PDF formatters.
 *
 * These are the only formats needing third-party libraries, so they are the
 * only ones behind a build step. Everything else in the extension is a plain
 * script the browser loads directly. See build.js and CONTRIBUTING.md.
 *
 * The bundle produced from this file is committed under vendor/, so cloning and
 * loading the extension unpacked still needs no npm install.
 *
 * PDF uses pdf-lib rather than a higher-level renderer. That means laying out
 * text by hand, but it keeps the bundle small and, most importantly, it
 * runs under Node, so the output is verified by tests instead of by eye.
 *
 * @license MIT
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  ShadingType, ExternalHyperlink, BorderStyle,
} from 'docx';
import { PDFDocument, StandardFonts, PDFName, PDFString, rgb } from 'pdf-lib';

const AISE = (globalThis.AISE = globalThis.AISE || {});

const fmtDate = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : null);

/** Labels avoid emoji: the standard PDF fonts have no glyphs for them. */
const ROLE_LABEL = { user: 'User', model: 'Model', thought: 'Model (Reasoning)' };

const roleOf = (turn) => (turn.isThought ? 'thought' : turn.role);

/**
 * Collect the header facts both formats show, so DOCX and PDF cannot drift
 * apart on which metadata a setting reveals.
 */
function headerFacts(conversation, settings) {
  const facts = [['Exported', fmtDate(conversation.exportedAt)]];
  if (settings.includeTimestamps && conversation.modifiedAt) {
    facts.push(['Last modified', fmtDate(conversation.modifiedAt)]);
  }
  if (settings.includeSourceUrl && conversation.url) facts.push(['Source', conversation.url]);

  const config = conversation.config;
  if (settings.includeModelConfig && config) {
    if (config.model) facts.push(['Model', config.model.replace(/^models\//, '')]);
    if (config.temperature !== null) facts.push(['Temperature', String(config.temperature)]);
    if (config.topP !== null) facts.push(['Top P', String(config.topP)]);
    if (config.topK !== null) facts.push(['Top K', String(config.topK)]);
  }
  if (settings.includeTokenCounts && conversation.stats.totalTokens !== null) {
    facts.push(['Total tokens', conversation.stats.totalTokens.toLocaleString('en-US')]);
  }
  facts.push(['Messages', String(conversation.stats.turnCount)]);
  return facts.filter(([, value]) => value);
}

function turnSubtitle(turn, settings) {
  const bits = [];
  if (settings.includeTimestamps && turn.timestamp) bits.push(fmtDate(turn.timestamp));
  if (settings.includeTokenCounts && turn.tokenCount !== null) bits.push(`${turn.tokenCount} tokens`);
  const excluded = turn.excludedAttachments || 0;
  if (excluded) bits.push(`${excluded} attachment${excluded === 1 ? '' : 's'} not included in export`);
  return bits.join('  |  ');
}

// --- Markdown ------------------------------------------------------------
//
// Models answer in Markdown, so a document that prints the source verbatim
// shows the reader `## Heading` and ``` fences instead of a heading and a code
// block. Both formats here parse the same subset so they cannot disagree about
// what a message looked like.

/**
 * Attachment links are relative to the document, which sits beside the
 * `attachments/` folder inside the export archive. Spaces and the like have to
 * be percent-encoded or the reader treats the URI as ending at the space.
 */
const assetUri = (path) => (path ? encodeURI(path) : null);

const isTableRule = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

const splitRow = (line) =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

/**
 * Split inline Markdown into styled runs. Emphasis markers only take effect
 * when a closing marker actually exists, so a lone asterisk in prose stays a
 * lone asterisk instead of italicising the rest of the message.
 *
 * @returns {Array<{text: string, bold: boolean, italic: boolean, code: boolean, link: ?string}>}
 */
function inlineRuns(text) {
  const src = String(text == null ? '' : text);
  const runs = [];
  let buffer = '';
  let bold = false;
  let italic = false;

  const flush = () => {
    if (!buffer) return;
    runs.push({ text: buffer, bold, italic, code: false, link: null });
    buffer = '';
  };

  for (let i = 0; i < src.length; ) {
    const char = src[i];

    if (char === '\\' && '\\`*_[]()#+-.!>'.includes(src[i + 1] || '')) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      let ticks = 1;
      while (src[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const end = src.indexOf(fence, i + ticks);
      if (end !== -1) {
        flush();
        runs.push({ text: src.slice(i + ticks, end).trim(), bold, italic, code: true, link: null });
        i = end + ticks;
        continue;
      }
    }

    if (char === '[' || (char === '!' && src[i + 1] === '[')) {
      const image = char === '!';
      const open = image ? i + 1 : i;
      const close = src.indexOf('](', open);
      const end = close === -1 ? -1 : src.indexOf(')', close + 2);
      if (end !== -1 && !src.slice(open, close).includes('\n')) {
        const label = src.slice(open + 1, close);
        const target = src.slice(close + 2, end).trim().split(/\s+/)[0];
        flush();
        runs.push({
          text: image ? `[image: ${label || target}]` : label || target,
          bold,
          italic: italic || image,
          code: false,
          link: image ? null : target,
        });
        i = end + 1;
        continue;
      }
    }

    // A bare URL. Markdown links are consumed above, so anything reaching here
    // is unlinked text the reader would otherwise have to retype.
    if ((char === 'h' || char === 'w') && !/[\w/]/.test(src[i - 1] || '')) {
      const bare = /^(?:https?:\/\/|www\.)[^\s<>()[\]]+/.exec(src.slice(i));
      // Trailing punctuation reads as sentence punctuation, not part of the URL.
      const url = bare ? bare[0].replace(/[.,;:!?]+$/, '') : '';
      if (url) {
        flush();
        runs.push({
          text: url, bold, italic, code: false,
          link: url.startsWith('www.') ? `https://${url}` : url,
        });
        i += url.length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      // `snake_case` is far more common in these conversations than mid-word
      // emphasis, so an underscore glued to a word stays literal.
      const glued = char === '_' && /\w/.test(src[i - 1] || '');
      const double = src[i + 1] === char;
      const marker = double ? char + char : char;
      const closes = double ? bold : italic;
      // `glued` only blocks *opening*: a closing marker is normally glued to
      // the last word of the emphasised run, as in `_really_`.
      if (closes || (!glued && src.indexOf(marker, i + marker.length) !== -1)) {
        flush();
        if (double) bold = !bold;
        else italic = !italic;
        i += marker.length;
        continue;
      }
    }

    buffer += char;
    i++;
  }

  flush();
  return runs.length ? runs : [{ text: '', bold: false, italic: false, code: false, link: null }];
}

/**
 * Block-level parse. Returns `heading`, `para`, `code`, `list`, `quote`,
 * `table` and `rule` blocks; anything unrecognised falls through to a
 * paragraph, which is what the old renderers did with everything.
 */
function parseBlocks(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fence) {
      const closer = new RegExp(`^\\s*\\${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, or the end of the message
      blocks.push({ type: 'code', lines: body, lang: fence[2] });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, runs: inlineRuns(heading[2]) });
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (line.includes('|') && isTableRule(lines[i + 1] || '')) {
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        if (!isTableRule(lines[i])) rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', runs: inlineRuns(body.join(' ').trim()) });
      continue;
    }

    const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    if (ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const match = ITEM.exec(lines[i]);
        if (match) {
          items.push({
            depth: Math.min(3, Math.floor(match[1].replace(/\t/g, '  ').length / 2)),
            marker: /^\d/.test(match[2]) ? match[2] : '-',
            text: match[3],
          });
          i++;
          continue;
        }
        // A wrapped continuation line belongs to the item above it.
        if (items.length && lines[i].trim() && /^\s+\S/.test(lines[i])) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        items: items.map((item) => ({ ...item, runs: inlineRuns(item.text) })),
      });
      continue;
    }

    const paragraph = [];
    const BREAKS = /^\s{0,3}(#{1,6}\s|>|(`{3,}|~{3,}))|^(\s*)([-*+]|\d{1,9}[.)])\s/;
    while (i < lines.length && lines[i].trim() && !BREAKS.test(lines[i])) paragraph.push(lines[i++].trim());
    blocks.push({ type: 'para', runs: inlineRuns(paragraph.join(' ')) });
  }

  return blocks;
}

/** Pad a parsed table into fixed-width rows a monospaced block can show. */
function tableToLines(rows) {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = [];
  for (let c = 0; c < columns; c++) {
    widths[c] = Math.max(...rows.map((row) => (row[c] || '').length));
  }
  const cells = (row) => row.map((cell, c) => String(cell).padEnd(widths[c])).join('  |  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('--+--');
  const [head, ...body] = rows;
  return [cells(head), divider, ...body.map(cells)];
}

// --- DOCX ----------------------------------------------------------------

/**
 * Per-role tints. `bg` shades every paragraph of the turn so the reader can
 * see where one message stops, and `bar` draws a coloured rule down its left
 * edge. Reasoning also recolours its body text, which is the only signal that
 * survives printing in greyscale.
 */
const DOCX_ROLE = {
  user: { bg: 'EEF2FF', bar: '5566DD', label: '3D4BB8', ink: null },
  model: { bg: 'FAFAFB', bar: 'C4C7CE', label: '2F3237', ink: null },
  thought: { bg: 'FFF8E8', bar: 'D9A429', label: '946A0A', ink: '6B5A32' },
};

const DOCX_CODE_BG = 'F1F3F5';
const DOCX_HEADING_SIZE = [0, 30, 26, 24, 22, 21, 21]; // half-points, by level

/** Paragraph decoration shared by every line of one turn. */
const turnFrame = (tint) =>
  tint
    ? {
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: tint.bg },
        border: { left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: tint.bar } },
      }
    : {};

const docxRuns = (runs, tint, extra) =>
  runs.map((run) => {
    const options = {
      text: run.text,
      bold: run.bold || (extra && extra.bold) || false,
      italics: run.italic || (extra && extra.italics) || false,
    };
    if (extra && extra.size) options.size = extra.size;
    if (run.code) {
      options.font = 'Consolas';
      options.color = 'A3246B';
      options.shading = { type: ShadingType.CLEAR, color: 'auto', fill: DOCX_CODE_BG };
    } else if (run.link) {
      options.color = '2255BB';
      options.underline = {};
    } else if (extra && extra.color) {
      options.color = extra.color;
    } else if (tint && tint.ink) {
      options.color = tint.ink;
    }
    const text = new TextRun(options);
    return run.link ? new ExternalHyperlink({ children: [text], link: run.link }) : text;
  });

/** Render parsed Markdown blocks as Word paragraphs. */
function docxBlocks(text, tint) {
  const frame = turnFrame(tint);
  const out = [];

  const mono = (lines) => {
    for (const line of lines.length ? lines : ['']) {
      out.push(new Paragraph({
        ...frame,
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: DOCX_CODE_BG },
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })],
      }));
    }
  };

  for (const block of parseBlocks(text)) {
    if (block.type === 'code') {
      mono(block.lines);
    } else if (block.type === 'table') {
      mono(tableToLines(block.rows));
    } else if (block.type === 'heading') {
      out.push(new Paragraph({
        ...frame,
        spacing: { before: 160, after: 60 },
        children: docxRuns(block.runs, tint, { bold: true, size: DOCX_HEADING_SIZE[block.level] }),
      }));
    } else if (block.type === 'quote') {
      out.push(new Paragraph({
        ...frame,
        indent: { left: 340 },
        children: docxRuns(block.runs, tint, { italics: true, color: '5A5E66' }),
      }));
    } else if (block.type === 'list') {
      for (const item of block.items) {
        out.push(new Paragraph({
          ...frame,
          indent: { left: 340 + item.depth * 280, hanging: 220 },
          spacing: { before: 0, after: 40 },
          children: [
            new TextRun({ text: `${item.marker}\t` }),
            ...docxRuns(item.runs, tint),
          ],
        }));
      }
    } else if (block.type === 'rule') {
      out.push(new Paragraph({
        ...frame,
        border: { ...(frame.border || {}), bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCED4' } },
        children: [],
      }));
    } else {
      out.push(new Paragraph({ ...frame, spacing: { after: 100 }, children: docxRuns(block.runs, tint) }));
    }
  }

  return out.length ? out : [new Paragraph({ ...frame, children: [] })];
}

function buildDocx(conversation, settings, assetPaths) {
  const children = [new Paragraph({ text: conversation.title, heading: HeadingLevel.TITLE })];

  for (const [key, value] of headerFacts(conversation, settings)) {
    const url = /^https?:\/\//.test(value) ? value : null;
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `${key}: `, bold: true }),
        ...docxRuns([{ text: value, bold: false, italic: false, code: false, link: url }], null),
      ],
      spacing: { after: 60 },
    }));
  }

  if (settings.includeSystemInstruction && conversation.systemInstruction) {
    children.push(new Paragraph({ text: 'System Instruction', heading: HeadingLevel.HEADING_2 }));
    children.push(...docxBlocks(conversation.systemInstruction, DOCX_ROLE.model));
  }

  const paths = assetPaths || new Map();

  for (const turn of conversation.turns) {
    const tint = DOCX_ROLE[roleOf(turn)] || DOCX_ROLE.model;
    const frame = turnFrame(tint);

    children.push(new Paragraph({
      ...frame,
      spacing: { before: 280, after: 40 },
      children: [new TextRun({ text: ROLE_LABEL[roleOf(turn)], bold: true, size: 24, color: tint.label })],
    }));

    const subtitle = turnSubtitle(turn, settings);
    if (subtitle) {
      children.push(new Paragraph({
        ...frame,
        children: [new TextRun({ text: subtitle, italics: true, size: 18, color: '767676' })],
      }));
    }

    for (const part of turn.parts) {
      const name = part.name || 'attachment';
      const target = assetUri(paths.get(part));
      children.push(new Paragraph({
        ...frame,
        spacing: { after: 40 },
        children: [
          new TextRun({ text: 'file  ', size: 18, color: '767676' }),
          ...docxRuns([{ text: name, bold: false, italic: !target, code: false, link: target || null }], tint),
        ],
      }));
    }

    children.push(...docxBlocks(turn.text, tint));
  }

  children.push(new Paragraph({
    children: [new TextRun({ text: 'Exported with AI Studio Exporter', italics: true, size: 16, color: '999999' })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 400 },
  }));

  return new Document({ sections: [{ children }] });
}

/**
 * Word refuses to open a package whose `[Content_Types].xml` is not the first
 * entry in the archive: "Word experienced an error trying to open the file".
 * with no hint as to why. OPC (ECMA-376 Part 2) requires that ordering, and
 * Packer emits it seventh, so every document produced here was unopenable.
 *
 * Rebuilding the archive with the content-types part first is the whole fix.
 * The parts themselves are untouched.
 */
async function withContentTypesFirst(blob) {
  const Zip = globalThis.JSZip;
  if (!Zip) throw new Error('JSZip is required to finalise a .docx package');

  const CONTENT_TYPES = '[Content_Types].xml';
  const source = await Zip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(source.files).filter((name) => !source.files[name].dir);
  if (names[0] === CONTENT_TYPES) return blob;
  if (!names.includes(CONTENT_TYPES)) throw new Error('.docx package has no [Content_Types].xml');

  const out = new Zip();
  out.file(CONTENT_TYPES, await source.files[CONTENT_TYPES].async('uint8array'));
  for (const name of names) {
    if (name === CONTENT_TYPES) continue;
    out.file(name, await source.files[name].async('uint8array'));
  }

  return out.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

const renderDocx = async (conversation, settings, assetPaths) =>
  withContentTypesFirst(await Packer.toBlob(buildDocx(conversation, settings, assetPaths)));

// --- PDF -----------------------------------------------------------------

const PAGE = { width: 595.28, height: 841.89 }; // A4, points
const MARGIN = 56;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;


const SUBSTITUTIONS = [
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/•/g, '-'],
  [/\t/g, '    '],
];

/**
 * Coerce text into something the standard fonts can draw. Common typographic
 * characters are substituted rather than dropped; anything still unencodable
 * becomes '?' so a single stray glyph cannot abort the whole export.
 */
function toWinAnsi(text) {
  let out = String(text == null ? '' : text);
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out.replace(/[^\u0020-\u007E\u00A0-\u00FF\n]/g, '?');
}

function hasUnsupportedGlyphs(conversation) {
  // Ask the real converter: anything it had to replace with '?' is a glyph the
  // standard fonts cannot draw. Checking the raw text instead would flag smart
  // quotes and dashes, which are substituted cleanly.
  return conversation.turns.some((turn) => {
    const text = turn.text || '';
    if (!text) return false;
    return toWinAnsi(text).includes('?') && !text.includes('?');
  });
}

/** Greedy word wrap against real glyph metrics. */
function wrapLine(text, font, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);

    // A single word wider than the column must be broken mid-word or it
    // overflows the page edge.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = '';
      for (const char of word) {
        if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Character-wise wrap for monospaced text, which must keep its indentation. */
function wrapMono(text, font, size, maxWidth) {
  const perChar = font.widthOfTextAtSize('0', size) || size * 0.6;
  const limit = Math.max(8, Math.floor(maxWidth / perChar));
  const out = [];
  let rest = text;
  do {
    out.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  } while (rest.length);
  return out;
}

/**
 * Lay styled runs out into lines, measuring each word with the font it will
 * actually be drawn in. Wrapping per-run instead would let a bold word push
 * past the column edge.
 */
function layoutRuns(runs, fontFor, size, maxWidth) {
  const tokens = [];
  for (const run of runs) {
    const font = fontFor(run);
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue;
      const space = /^\s+$/.test(piece);
      tokens.push({
        text: space ? ' ' : piece,
        space,
        run,
        font,
        width: font.widthOfTextAtSize(space ? ' ' : piece, size),
      });
    }
  }

  const lines = [];
  let line = [];
  let width = 0;
  const push = () => {
    while (line.length && line[line.length - 1].space) line.pop();
    if (line.length) lines.push(line);
    line = [];
    width = 0;
  };

  for (const token of tokens) {
    if (token.space) {
      if (!line.length) continue;
      line.push(token);
      width += token.width;
      continue;
    }

    // A token wider than the whole column (a URL, a long identifier) has to be
    // broken mid-word or it runs off the page.
    if (token.width > maxWidth) {
      push();
      let chunk = '';
      let chunkWidth = 0;
      for (const char of token.text) {
        const charWidth = token.font.widthOfTextAtSize(char, size);
        if (chunkWidth + charWidth > maxWidth && chunk) {
          lines.push([{ text: chunk, run: token.run, font: token.font, width: chunkWidth }]);
          chunk = char;
          chunkWidth = charWidth;
        } else {
          chunk += char;
          chunkWidth += charWidth;
        }
      }
      if (chunk) {
        line = [{ text: chunk, run: token.run, font: token.font, width: chunkWidth }];
        width = chunkWidth;
      }
      continue;
    }

    if (width + token.width > maxWidth && line.length) push();
    line.push(token);
    width += token.width;
  }
  push();

  return lines.length ? lines : [[]];
}

/** Palette. Reasoning is the one role that also recolours its body text. */
const PDF_THEME = {
  ink: rgb(0.09, 0.10, 0.12),
  muted: rgb(0.45, 0.47, 0.51),
  link: rgb(0.11, 0.31, 0.72),
  codeInk: rgb(0.64, 0.11, 0.42),
  codeBg: rgb(0.945, 0.953, 0.965),
  codeEdge: rgb(0.87, 0.88, 0.90),
  rule: rgb(0.82, 0.83, 0.86),
  roles: {
    user: { bg: rgb(0.933, 0.949, 0.996), bar: rgb(0.33, 0.40, 0.87), label: rgb(0.24, 0.29, 0.72), ink: null },
    model: { bg: rgb(0.980, 0.980, 0.984), bar: rgb(0.77, 0.78, 0.82), label: rgb(0.18, 0.20, 0.23), ink: null },
    thought: { bg: rgb(1, 0.973, 0.910), bar: rgb(0.85, 0.64, 0.16), label: rgb(0.58, 0.41, 0.04), ink: rgb(0.40, 0.33, 0.18) },
  },
};

const PAD = 12; // gutter between the block edge and its text
const FOOTER = 34; // room reserved for the page number

async function renderPdf(conversation, settings, assetPaths) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(conversation.title || 'AI Studio conversation');
  pdf.setCreator('AI Studio Exporter');

  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const paths = assetPaths || new Map();

  const fontFor = (run) => {
    if (run.code) return run.bold ? fonts.monoBold : fonts.mono;
    if (run.bold && run.italic) return fonts.boldItalic;
    if (run.bold) return fonts.bold;
    if (run.italic) return fonts.italic;
    return fonts.regular;
  };

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  let tint = null; // the role block currently being painted, if any

  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };

  /**
   * Move down `height` points, painting the active role's background behind
   * the strip just vacated. Painting band by band rather than one rectangle
   * per turn is what lets a message straddle a page break without leaving its
   * colour behind.
   */
  const advance = (height) => {
    if (y - height < MARGIN + FOOTER) newPage();
    if (tint) {
      page.drawRectangle({ x: MARGIN, y: y - height, width: CONTENT_WIDTH, height, color: tint.bg });
      page.drawRectangle({ x: MARGIN, y: y - height, width: 2.5, height, color: tint.bar });
    }
    y -= height;
  };

  const linkTo = (uri, x, bottom, width, height) => {
    const annotation = pdf.context.register(pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, bottom, x + width, bottom + height],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
    }));
    const key = PDFName.of('Annots');
    const existing = page.node.get(key);
    if (existing && existing.push) existing.push(annotation);
    else page.node.set(key, pdf.context.obj([annotation]));
  };

  const tintInk = () => (tint && tint.ink) || PDF_THEME.ink;

  /** Draw already-parsed runs as a wrapped, styled paragraph. */
  const drawRuns = (runs, options = {}) => {
    const { size = 10, indent = 0, color = null, gap = 5, bullet = null, quoted = false } = options;
    const lineHeight = size * 1.45;
    const left = MARGIN + PAD + indent;
    const lines = layoutRuns(runs, fontFor, size, CONTENT_WIDTH - PAD * 2 - indent);

    lines.forEach((line, index) => {
      advance(lineHeight);
      const baseline = y + lineHeight - size;

      if (quoted) {
        page.drawRectangle({ x: left - 8, y, width: 2, height: lineHeight, color: PDF_THEME.rule });
      }
      if (bullet && index === 0) {
        page.drawText(bullet, {
          x: left - fonts.regular.widthOfTextAtSize(`${bullet} `, size),
          y: baseline, size, font: fonts.regular, color: color || PDF_THEME.muted,
        });
      }

      let x = left;
      for (const token of line) {
        const run = token.run;
        const paint = run.code ? PDF_THEME.codeInk : run.link ? PDF_THEME.link : color || tintInk();
        page.drawText(token.text, { x, y: baseline, size, font: token.font, color: paint });
        if (run.link) {
          // Spaces inside a link get the rule too, or a multi-word filename
          // comes out as a row of disconnected underlines.
          page.drawLine({
            start: { x, y: baseline - 1.5 }, end: { x: x + token.width, y: baseline - 1.5 },
            thickness: 0.5, color: PDF_THEME.link,
          });
          linkTo(run.link, x, y, token.width, lineHeight);
        }
        x += token.width;
      }
    });

    // Painted rather than skipped: an unpainted gap would cut a white stripe
    // through the role's background between every paragraph.
    if (gap) advance(gap);
  };

  /**
   * Shaded, monospaced box: code fences and tables both land here. Drawn one
   * strip at a time on top of the role band, so the shading follows the block
   * across a page break instead of being clipped at the boundary.
   */
  const drawMono = (rawLines, gap = 6) => {
    const size = 8.5;
    const lineHeight = size * 1.4;
    const boxLeft = MARGIN + PAD;
    const boxWidth = CONTENT_WIDTH - PAD * 2;

    const strip = (height) => {
      advance(height);
      page.drawRectangle({ x: boxLeft, y, width: boxWidth, height, color: PDF_THEME.codeBg });
      page.drawRectangle({ x: boxLeft, y, width: 2, height, color: PDF_THEME.codeEdge });
    };

    const wrapped = [];
    for (const raw of rawLines.length ? rawLines : ['']) {
      const line = toWinAnsi(raw).replace(/\s+$/, '');
      for (const piece of wrapMono(line, fonts.mono, size, boxWidth - 12)) wrapped.push(piece);
    }

    strip(5);
    for (const line of wrapped) {
      strip(lineHeight);
      page.drawText(line, {
        x: boxLeft + 6, y: y + lineHeight - size, size, font: fonts.mono, color: PDF_THEME.ink,
      });
    }
    strip(5);
    if (gap) advance(gap);
  };

  const HEADING_SIZE = [0, 15, 13, 11.5, 10.5, 10, 10];

  const drawMarkdown = (text) => {
    for (const block of parseBlocks(toWinAnsi(text))) {
      if (block.type === 'code') {
        drawMono(block.lines);
      } else if (block.type === 'table') {
        drawMono(tableToLines(block.rows));
      } else if (block.type === 'heading') {
        advance(4);
        drawRuns(block.runs.map((run) => ({ ...run, bold: true })), {
          size: HEADING_SIZE[block.level], gap: 3,
        });
      } else if (block.type === 'quote') {
        drawRuns(block.runs.map((run) => ({ ...run, italic: true })), {
          indent: 14, color: PDF_THEME.muted, quoted: true,
        });
      } else if (block.type === 'list') {
        for (const item of block.items) {
          drawRuns(item.runs, { indent: 16 + item.depth * 14, bullet: item.marker, gap: 2 });
        }
        advance(3);
      } else if (block.type === 'rule') {
        advance(8);
        page.drawRectangle({
          x: MARGIN + PAD, y: y + 4, width: CONTENT_WIDTH - PAD * 2, height: 0.6, color: PDF_THEME.rule,
        });
      } else {
        drawRuns(block.runs);
      }
    }
  };

  const plain = (text, options) => drawRuns([{ text, bold: false, italic: false, code: false, link: null }], options);

  // --- cover block ---
  plain(toWinAnsi(conversation.title || 'Untitled Conversation'), { size: 19, gap: 8 });
  for (const [key, value] of headerFacts(conversation, settings)) {
    const isUrl = /^https?:\/\//.test(value);
    drawRuns(
      [
        { text: `${key}: `, bold: true, italic: false, code: false, link: null },
        { text: toWinAnsi(value), bold: false, italic: false, code: false, link: isUrl ? value : null },
      ],
      { size: 9, color: PDF_THEME.muted, gap: 1 },
    );
  }
  y -= 10;

  if (settings.includeSystemInstruction && conversation.systemInstruction) {
    plain('System Instruction', { size: 12.5, color: PDF_THEME.roles.model.label, gap: 3 });
    tint = PDF_THEME.roles.model;
    advance(6);
    drawMarkdown(conversation.systemInstruction);
    advance(6);
    tint = null;
    y -= 6;
  }

  // --- messages ---
  for (const turn of conversation.turns) {
    y -= 10;
    if (y < MARGIN + FOOTER + 60) newPage();

    tint = PDF_THEME.roles[roleOf(turn)] || PDF_THEME.roles.model;
    advance(8);

    plain(ROLE_LABEL[roleOf(turn)], { size: 11.5, color: tint.label, gap: 1 });

    const subtitle = turnSubtitle(turn, settings);
    if (subtitle) plain(toWinAnsi(subtitle), { size: 8, color: PDF_THEME.muted, gap: 3 });

    for (const part of turn.parts) {
      const target = assetUri(paths.get(part));
      drawRuns(
        [
          { text: 'file  ', bold: false, italic: false, code: false, link: null },
          {
            text: toWinAnsi(part.name || 'attachment'),
            bold: false, italic: !target, code: false, link: target,
          },
        ],
        { size: 9, color: PDF_THEME.muted, gap: 1 },
      );
    }
    if (turn.parts.length) advance(3);

    if (turn.text) drawMarkdown(turn.text);
    advance(8);
    tint = null;
  }

  // Page numbers, added last so the total is known.
  const pages = pdf.getPages();
  pages.forEach((p, index) => {
    const label = `${index + 1} / ${pages.length}`;
    p.drawText(label, {
      x: (PAGE.width - fonts.regular.widthOfTextAtSize(label, 8)) / 2,
      y: MARGIN / 2,
      size: 8,
      font: fonts.regular,
      color: rgb(0.6, 0.6, 0.6),
    });
  });

  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

// --- registration --------------------------------------------------------

AISE.formats = AISE.formats || {};

AISE.formats.docx = {
  id: 'docx',
  label: 'Word document (.docx)',
  extension: 'docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pro: true,
  bundlesAssets: true,
  binary: true,
  render: renderDocx,
};

AISE.formats.pdf = {
  id: 'pdf',
  label: 'PDF (.pdf)',
  extension: 'pdf',
  mimeType: 'application/pdf',
  pro: true,
  bundlesAssets: true,
  binary: true,
  render: renderPdf,
  warn: (conversation) =>
    hasUnsupportedGlyphs(conversation)
      ? 'This conversation contains characters the standard PDF fonts cannot draw, ' +
        'and they will appear as "?". Export as HTML and print to PDF from your ' +
        'browser to keep them readable.'
      : null,
  hasUnsupportedGlyphs,
  toWinAnsi,
  wrapLine,
  // Exposed for tests: the Markdown parse is shared with the DOCX renderer and
  // is the part most likely to break on a real conversation.
  parseBlocks,
  inlineRuns,
};
