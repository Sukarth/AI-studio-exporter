/**
 * Smoke test for the bundled DOCX and PDF formatters.
 *
 * Separate from test/run.js because it needs the build output. The plain
 * formatters must stay testable without ever running a build, so this file is
 * skipped rather than failed when vendor/ has not been generated.
 *
 * Asserting on file signatures rather than a byte count is deliberate: these
 * libraries can return a plausible-looking empty container when handed input
 * they dislike, and only the magic bytes prove a real document came out.
 *
 * @license MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'vendor', 'pro-documents.bundle.js');

if (!fs.existsSync(BUNDLE)) {
  console.log('vendor bundle missing - run `npm run build` first. Skipping.');
  process.exit(0);
}

// The bundle targets a browser. Node 18+ supplies Blob and structuredClone;
// the rest is what pdfmake and docx touch on load.
globalThis.window = globalThis;
globalThis.self = globalThis;
// navigator is a getter-only global in modern Node, so leave it alone if present.
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
}
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
};

// The docx renderer rebuilds its package with JSZip so the content-types part
// comes first; in the browser that global comes from libs/jszip.min.js, loaded
// as a content script before the bundle.
const JSZip = (0, eval)(
  fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip'
);
globalThis.JSZip = JSZip;

require(BUNDLE);
require(path.join(ROOT, 'src', 'model.js'));
require(path.join(ROOT, 'src', 'api', 'decode.js'));

const { AISE } = globalThis;

// In the browser the PDF fonts are fetched from the extension; here they are
// read from disk. Counted, so a test can prove an English PDF never loads them.
let fontReads = 0;
AISE.readExtensionFile = async (file) => {
  fontReads++;
  return new Uint8Array(fs.readFileSync(path.join(ROOT, file)));
};

/** Every inflated stream in a PDF, as latin1 text, for searching. */
function pdfStreams(bytes) {
  const out = [];
  let cursor = 0;
  while (true) {
    const start = bytes.indexOf('stream', cursor);
    if (start === -1) break;
    let from = start + 6;
    if (bytes[from] === 13) from++;
    if (bytes[from] === 10) from++;
    const end = bytes.indexOf('endstream', from);
    if (end === -1) break;
    try {
      out.push(zlib.inflateSync(bytes.subarray(from, end)).toString('latin1'));
    } catch (_) { /* not every stream is deflated */ }
    cursor = end + 9;
  }
  return out;
}

const SETTINGS = {
  includeModelConfig: true, includeSystemInstruction: true,
  includeTimestamps: true, includeTokenCounts: true, includeSourceUrl: true,
};

function fixture() {
  const conversation = AISE.model.emptyConversation('ABC123', 'api');
  conversation.title = 'Smoke Test Conversation';
  conversation.config = {
    model: 'models/gemini-3-pro', temperature: 1, topP: 0.95, topK: 64,
    maxOutputTokens: 65536, safetySettings: [],
  };
  conversation.turns = [
    AISE.model.makeTurn('user', 'What is 2+2?', { tokenCount: 5, timestamp: Date.now() }),
    AISE.model.makeTurn('model', 'Let me think.', { isThought: true, tokenCount: 11 }),
    AISE.model.makeTurn('model', 'It is 4.\n\nSecond paragraph.', { tokenCount: 7 }),
  ];
  return AISE.model.recomputeStats(conversation);
}

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push({ name, error });
  }
}

async function toBytes(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

(async () => {
  await test('both document formats are registered and flagged pro', () => {
    assert.ok(AISE.formats.docx, 'docx registered');
    assert.ok(AISE.formats.pdf, 'pdf registered');
    assert.strictEqual(AISE.formats.docx.pro, true);
    assert.strictEqual(AISE.formats.pdf.pro, true);
    assert.strictEqual(AISE.formats.docx.binary, true);
    assert.strictEqual(AISE.formats.pdf.binary, true);
  });

  await test('docx renders a real OOXML package', async () => {
    const bytes = await toBytes(await AISE.formats.docx.render(fixture(), SETTINGS));
    // OOXML is a ZIP: "PK\x03\x04".
    assert.strictEqual(bytes.subarray(0, 4).toString('hex'), '504b0304', 'ZIP signature');
    assert.ok(bytes.length > 4000, `expected a populated package, got ${bytes.length} bytes`);
    assert.ok(bytes.includes(Buffer.from('word/document.xml')), 'contains the document part');
  });

  await test('docx puts [Content_Types].xml first, as OPC requires', async () => {
    // Word refuses a package where it is not the first entry, with an error
    // that names no cause. Every document this project produced was unopenable
    // until this was fixed, and a signature check cannot see it: a broken
    // package is still a valid ZIP.
    const bytes = await toBytes(await AISE.formats.docx.render(fixture(), SETTINGS));
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    assert.strictEqual(names[0], '[Content_Types].xml', `first entry was ${names[0]}`);
  });

  await test('docx contains every part the package declares', async () => {
    const bytes = await toBytes(await AISE.formats.docx.render(fixture(), SETTINGS));
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

    for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      assert.ok(names.includes(required), `missing ${required}`);
    }

    // An Override naming a part that is not in the archive is fatal to Word.
    const contentTypes = await zip.files['[Content_Types].xml'].async('string');
    const declared = [...contentTypes.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]);
    const absent = declared.filter((p) => !names.includes(p));
    assert.deepStrictEqual(absent, [], 'declared parts missing from the archive');

    // And the reverse: a relationship pointing at nothing.
    const rels = await zip.files['word/_rels/document.xml.rels'].async('string');
    const doc = await zip.files['word/document.xml'].async('string');
    const ids = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
    const used = [...doc.matchAll(/r:(?:id|embed|link)="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(used.filter((id) => !ids.has(id)), [], 'dangling relationship ids');
  });

  await test('docx survives text the document body cannot express raw', async () => {
    // Ampersands, angle brackets and astral-plane emoji all have to reach the
    // XML escaped or paired; getting either wrong produces a package that
    // opens nowhere.
    const c = fixture();
    c.turns[0].text = 'a & b < c > d "quoted" 👾 emoji';
    c.title = 'Title & <Angle>';
    const bytes = await toBytes(await AISE.formats.docx.render(c, SETTINGS));
    const zip = await JSZip.loadAsync(bytes);
    const doc = await zip.files['word/document.xml'].async('string');

    assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(doc), 'unescaped ampersand');
    let lone = 0;
    for (let i = 0; i < doc.length; i++) {
      const code = doc.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = doc.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
        else lone++;
      } else if (code >= 0xdc00 && code <= 0xdfff) lone++;
    }
    assert.strictEqual(lone, 0, 'unpaired surrogate in the document body');
  });

  await test('pdf renders a real PDF', async () => {
    const bytes = await toBytes(await AISE.formats.pdf.render(fixture(), SETTINGS));
    assert.strictEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'PDF header');
    assert.ok(bytes.subarray(-1024).includes(Buffer.from('%%EOF')), 'properly terminated');
    assert.ok(bytes.length > 1000, `expected a populated PDF, got ${bytes.length} bytes`);
  });

  // --- Markdown, shared by both formats ---------------------------------
  const { parseBlocks, inlineRuns } = AISE.formats.pdf;

  await test('markdown blocks are recognised, not printed as source', () => {
    const blocks = parseBlocks([
      '## Heading',
      '',
      'A paragraph that',
      'wraps in the source.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '> quoted',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '---',
    ].join('\n'));

    assert.deepStrictEqual(blocks.map((b) => b.type),
      ['heading', 'para', 'code', 'quote', 'list', 'table', 'rule']);
    assert.strictEqual(blocks[0].level, 2);
    // Soft-wrapped source lines are one paragraph, as Markdown defines them.
    assert.strictEqual(blocks[1].runs[0].text, 'A paragraph that wraps in the source.');
    assert.deepStrictEqual(blocks[2].lines, ['const x = 1;']);
    assert.strictEqual(blocks[2].lang, 'js');
    assert.strictEqual(blocks[4].items.length, 2);
    assert.deepStrictEqual(blocks[5].rows, [['a', 'b'], ['1', '2']]);
  });

  await test('fenced code keeps its own indentation and markup', () => {
    // Inside a fence nothing is Markdown: a leading # is a comment, not a
    // heading, and leading spaces carry meaning.
    const [block] = parseBlocks('```\n# not a heading\n    indented\n```');
    assert.strictEqual(block.type, 'code');
    assert.deepStrictEqual(block.lines, ['# not a heading', '    indented']);
  });

  await test('an unterminated fence still ends the message cleanly', () => {
    const [block] = parseBlocks('```py\nprint(1)\nprint(2)');
    assert.strictEqual(block.type, 'code');
    assert.deepStrictEqual(block.lines, ['print(1)', 'print(2)']);
  });

  await test('inline markers only fire when they close', () => {
    const runs = inlineRuns('a **bold** and `code` and *em* but 2 * 3 stands alone');
    const styled = runs.filter((r) => r.bold || r.italic || r.code);
    assert.deepStrictEqual(styled.map((r) => r.text), ['bold', 'code', 'em']);
    assert.strictEqual(runs.map((r) => r.text).join(''),
      'a bold and code and em but 2 * 3 stands alone');
  });

  await test('identifiers keep their underscores', () => {
    // These conversations are full of snake_case; treating the underscores as
    // emphasis silently deletes characters from the reader's code.
    const runs = inlineRuns('call some_long_name(other_arg) then _really_ stop');
    assert.strictEqual(runs.map((r) => r.text).join(''),
      'call some_long_name(other_arg) then really stop');
    assert.deepStrictEqual(runs.filter((r) => r.italic).map((r) => r.text), ['really']);
  });

  await test('links and bare URLs both become link runs', () => {
    const runs = inlineRuns('see [docs](https://x.test/a) or https://y.test/b, then stop');
    const links = runs.filter((r) => r.link);
    assert.deepStrictEqual(links.map((r) => [r.text, r.link]), [
      ['docs', 'https://x.test/a'],
      ['https://y.test/b', 'https://y.test/b'],
    ]);
    // The comma is sentence punctuation, not part of the address.
    assert.ok(runs.map((r) => r.text).join('').endsWith(', then stop'));
  });

  await test('pdf embeds a link annotation per attachment and URL', async () => {
    // The visible blue text is cosmetic; only the annotation makes it
    // clickable, and it lives inside a compressed object stream where a plain
    // byte search cannot see it.
    const c = fixture();
    c.url = 'https://aistudio.google.com/prompts/ABC123';
    c.turns[0].parts = [{ name: 'a file.png', mimeType: 'image/png', type: 'image' }];
    const paths = new Map([[c.turns[0].parts[0], 'attachments/a file.png']]);

    const bytes = await toBytes(await AISE.formats.pdf.render(c, SETTINGS, paths));
    const uris = new Set();
    let cursor = 0;
    while (true) {
      const start = bytes.indexOf('stream', cursor);
      if (start === -1) break;
      let from = start + 6;
      if (bytes[from] === 13) from++;
      if (bytes[from] === 10) from++;
      const end = bytes.indexOf('endstream', from);
      if (end === -1) break;
      try {
        const text = zlib.inflateSync(bytes.subarray(from, end)).toString('latin1');
        for (const m of text.matchAll(/\/Subtype \/Link[\s\S]*?\/URI \(([^)]*)\)/g)) uris.add(m[1]);
      } catch (_) { /* content streams and images are not object streams */ }
      cursor = end + 9;
    }

    assert.ok(uris.has('https://aistudio.google.com/prompts/ABC123'), 'source URL is clickable');
    // Spaces must be encoded or a reader stops the URI at the first one.
    assert.ok(uris.has('attachments/a%20file.png'), `attachment link missing, got ${[...uris]}`);
  });

  await test('docx hyperlinks its attachments too', async () => {
    const c = fixture();
    c.turns[0].parts = [{ name: 'a file.png', mimeType: 'image/png', type: 'image' }];
    const paths = new Map([[c.turns[0].parts[0], 'attachments/a file.png']]);

    const zip = await JSZip.loadAsync(await toBytes(await AISE.formats.docx.render(c, SETTINGS, paths)));
    const rels = await zip.files['word/_rels/document.xml.rels'].async('string');
    assert.ok(rels.includes('attachments/a%20file.png'), 'relationship targets the asset');
    assert.ok(/TargetMode="External"/.test(rels), 'declared as an external link');
  });

  await test('pdf warns only for characters its font lacks', async () => {
    const latin = fixture();
    assert.strictEqual(await AISE.formats.pdf.warn(latin), null, 'no warning for Latin text');

    const russian = fixture();
    russian.title = 'Экспорт разговора';
    russian.turns[0].text = 'Привет! Как дела? Γειά σου. Tiếng Việt.';
    assert.strictEqual(await AISE.formats.pdf.warn(russian), null, 'Cyrillic, Greek and Vietnamese are drawable');

    const kannada = fixture();
    kannada.turns[0].text = 'ಕನ್ನಡ ಪಠ್ಯ';
    const warning = await AISE.formats.pdf.warn(kannada);
    assert.ok(warning, 'Kannada is flagged');
    assert.ok(/Word/.test(warning) && /HTML/.test(warning), 'points at both workarounds');
    assert.ok(warning.includes('ಕ'), 'names a character it cannot draw');

    const chinese = fixture();
    chinese.turns[0].text = 'Привет 你好';
    assert.ok((await AISE.formats.pdf.warn(chinese)).includes('你'), 'Chinese is flagged, even beside Cyrillic');
  });

  await test('an English PDF uses the standard fonts and loads nothing', async () => {
    const before = fontReads;
    const bytes = await toBytes(await AISE.formats.pdf.render(fixture(), SETTINGS));
    assert.ok(!/FontFile2/.test([bytes.toString('latin1'), ...pdfStreams(bytes)].join('\n')), 'no font program embedded');
    assert.ok(bytes.length < 20000, `stays small, got ${bytes.length} bytes`);
    // Loaded fonts are cached for the page, so only an untouched counter
    // proves this render did not ask for them.
    assert.ok(fontReads === before || before > 0, 'font files not read for Latin text');
  });

  await test('a Russian PDF embeds Noto Sans and draws Cyrillic, not "?"', async () => {
    const c = fixture();
    c.title = 'Экспорт разговора';
    c.turns[0].text = 'Привет! **Жирный** и *курсив*, `код_пример` и обычный текст.';
    const bytes = await toBytes(await AISE.formats.pdf.render(c, SETTINGS));

    assert.strictEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'PDF header');
    // Font dictionaries live in compressed object streams, so search those too.
    const all = [bytes.toString('latin1'), ...pdfStreams(bytes)].join('\n');
    assert.ok(/FontFile2/.test(all), 'a TrueType font is embedded');
    assert.ok(/NotoSans/.test(all), 'the embedded font is Noto Sans');
    assert.ok(/NotoSansMono/.test(all), 'inline code uses the mono face');
    // Text drawn in an embedded font is written as glyph ids (<...> Tj), not
    // as the "(????)" literal strings the standard fonts would have produced.
    const content = pdfStreams(bytes).join('\n');
    assert.ok(/<[0-9A-F]+> Tj/.test(content), 'text is drawn as glyph ids');
    assert.ok(!/\(\?{4,}/.test(content), 'no run of question marks');
  });

  await test('characters the font lacks still become "?" rather than breaking the PDF', async () => {
    const c = fixture();
    c.turns[0].text = 'Привет 你好 мир';
    const bytes = await toBytes(await AISE.formats.pdf.render(c, SETTINGS));
    assert.ok(bytes.subarray(-1024).includes(Buffer.from('%%EOF')), 'a complete PDF');
    const { toCovered } = AISE.formats.pdf;
    const coverage = new Set([...'Привет мир?'].map((ch) => ch.codePointAt(0)));
    assert.strictEqual(toCovered('Привет 你好 мир', coverage), 'Привет ?? мир');
  });

  await test('typographic characters survive in a Unicode PDF', () => {
    // With the standard fonts, smart quotes and dashes are swapped for ASCII;
    // Noto has them, so they should be kept as written.
    const { toCovered } = AISE.formats.pdf;
    const coverage = new Set([...'“”–—…Ab '].map((ch) => ch.codePointAt(0)));
    assert.strictEqual(toCovered('“A” – b — …', coverage), '“A” – b — …');
    // And where a font lacks one, the ASCII stand-in is used, not '?'.
    const ascii = new Set([...'Ab"-. '].map((ch) => ch.codePointAt(0)));
    assert.strictEqual(toCovered('“A” – b', ascii), '"A" - b');
  });

  for (const { name, error } of failures) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
