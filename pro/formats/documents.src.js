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
 * text by hand, but it keeps the bundle small and — the deciding factor — it
 * runs under Node, so the output is verified by tests instead of by eye.
 *
 * @license MIT
 */
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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
  return bits.join('  |  ');
}

// --- DOCX ----------------------------------------------------------------

function buildDocx(conversation, settings) {
  const children = [new Paragraph({ text: conversation.title, heading: HeadingLevel.TITLE })];

  for (const [key, value] of headerFacts(conversation, settings)) {
    children.push(new Paragraph({
      children: [new TextRun({ text: `${key}: `, bold: true }), new TextRun({ text: value })],
      spacing: { after: 60 },
    }));
  }

  if (settings.includeSystemInstruction && conversation.systemInstruction) {
    children.push(new Paragraph({ text: 'System Instruction', heading: HeadingLevel.HEADING_2 }));
    for (const line of conversation.systemInstruction.split('\n')) {
      children.push(new Paragraph({ text: line, style: 'IntenseQuote' }));
    }
  }

  for (const turn of conversation.turns) {
    children.push(new Paragraph({
      text: ROLE_LABEL[roleOf(turn)],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280 },
    }));

    const subtitle = turnSubtitle(turn, settings);
    if (subtitle) {
      children.push(new Paragraph({
        children: [new TextRun({ text: subtitle, italics: true, size: 18, color: '767676' })],
      }));
    }

    for (const part of turn.parts) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `[attachment: ${part.name || 'attachment'}]`, italics: true })],
      }));
    }

    // Word treats a blank paragraph as a real break, so preserve the message's
    // own line structure rather than collapsing it.
    for (const line of (turn.text || '').split('\n')) {
      children.push(new Paragraph({ text: line }));
    }
  }

  children.push(new Paragraph({
    children: [new TextRun({ text: 'Exported with AI Studio Exporter', italics: true, size: 16, color: '999999' })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 400 },
  }));

  return new Document({ sections: [{ children }] });
}

const renderDocx = (conversation, settings) => Packer.toBlob(buildDocx(conversation, settings));

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

async function renderPdf(conversation, settings) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(conversation.title || 'AI Studio conversation');
  pdf.setCreator('AI Studio Exporter');

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };

  const write = (text, { font = regular, size = 10, color = rgb(0, 0, 0), gap = 3, indent = 0 } = {}) => {
    const lineHeight = size * 1.35;
    for (const raw of toWinAnsi(text).split('\n')) {
      for (const line of wrapLine(raw, font, size, CONTENT_WIDTH - indent)) {
        if (y - lineHeight < MARGIN) newPage();
        page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color });
        y -= lineHeight;
      }
    }
    y -= gap;
  };

  write(conversation.title || 'Untitled Conversation', { font: bold, size: 18, gap: 8 });

  for (const [key, value] of headerFacts(conversation, settings)) {
    write(`${key}: ${value}`, { size: 9, color: rgb(0.33, 0.33, 0.33), gap: 1 });
  }
  y -= 8;

  if (settings.includeSystemInstruction && conversation.systemInstruction) {
    write('System Instruction', { font: bold, size: 12, color: rgb(0.3, 0.32, 0.75), gap: 2 });
    write(conversation.systemInstruction, { font: italic, indent: 14 });
  }

  for (const turn of conversation.turns) {
    y -= 8;
    if (y < MARGIN + 40) newPage();

    write(ROLE_LABEL[roleOf(turn)], { font: bold, size: 12, color: rgb(0.3, 0.32, 0.75), gap: 1 });

    const subtitle = turnSubtitle(turn, settings);
    if (subtitle) write(subtitle, { font: italic, size: 8, color: rgb(0.47, 0.47, 0.47), gap: 2 });

    for (const part of turn.parts) {
      write(`[attachment: ${part.name || 'attachment'}]`, {
        font: italic, size: 9, color: rgb(0.47, 0.47, 0.47), gap: 1,
      });
    }
    if (turn.text) write(turn.text);
  }

  // Page numbers, added last so the total is known.
  const pages = pdf.getPages();
  pages.forEach((p, index) => {
    const label = `${index + 1} / ${pages.length}`;
    p.drawText(label, {
      x: (PAGE.width - regular.widthOfTextAtSize(label, 8)) / 2,
      y: MARGIN / 2,
      size: 8,
      font: regular,
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
};
