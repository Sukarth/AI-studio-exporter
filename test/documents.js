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

require(BUNDLE);
require(path.join(ROOT, 'src', 'model.js'));
require(path.join(ROOT, 'src', 'api', 'decode.js'));

const { AISE } = globalThis;

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

  await test('pdf renders a real PDF', async () => {
    const bytes = await toBytes(await AISE.formats.pdf.render(fixture(), SETTINGS));
    assert.strictEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'PDF header');
    assert.ok(bytes.subarray(-1024).includes(Buffer.from('%%EOF')), 'properly terminated');
    assert.ok(bytes.length > 1000, `expected a populated PDF, got ${bytes.length} bytes`);
  });

  await test('pdf warns when text needs glyphs the bundled font lacks', () => {
    const latin = fixture();
    assert.strictEqual(AISE.formats.pdf.warn(latin), null, 'no warning for Latin text');

    const kannada = fixture();
    kannada.turns[0].text = 'ಕನ್ನಡ ಪಠ್ಯ';
    const warning = AISE.formats.pdf.warn(kannada);
    assert.ok(warning, 'non-Latin text is flagged');
    assert.ok(/HTML/.test(warning), 'points at the workaround');
  });

  for (const { name, error } of failures) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
