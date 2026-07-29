/**
 * Test runner. No framework — the extension ships no build step and no
 * node_modules, and keeping it that way means a contributor can clone and run
 * `npm test` with nothing installed.
 *
 * Source files are plain IIFEs that hang themselves off globalThis, so loading
 * them here is just an eval in this process.
 *
 * @license MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function load(...relativePaths) {
  for (const rel of relativePaths) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(code);
  }
}

load(
  'src/model.js',
  'src/api/decode.js',
  'src/formats/markdown.js',
  'src/formats/json.js',
  'src/formats/text.js'
);

const { AISE } = globalThis;

const ALL_ON = {
  scrapeImages: true,
  scrapeAttachments: true,
  scrapeReasoning: true,
  includeSystemInstruction: true,
  includeModelConfig: true,
  includeTimestamps: true,
  includeTokenCounts: true,
  includeSourceUrl: true,
};

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push({ name, error });
  }
}

// --- fixtures -----------------------------------------------------------

/** A wire-format prompt exercising every slot the decoder reads. */
function wirePrompt() {
  const turn = (over) => {
    const t = new Array(36).fill(null);
    t[8] = 'user';
    t[28] = '';
    t[30] = 0;
    t[31] = 0;
    t[35] = '';
    return Object.assign(t, over);
  };

  const userTurn = turn({ 0: 'What is 2+2?', 18: 5, 32: [1784274199, 457000000] });
  const thoughtTurn = turn({ 0: 'The user wants arithmetic.', 8: 'model', 16: 1, 18: 11, 32: [1784274200, 0] });
  const modelTurn = turn({ 0: 'It is 4.', 8: 'model', 18: 7, 32: [1784274201, 0] });
  const attachmentTurn = turn({ 3: ['1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7'], 18: 900 });
  const inlineFileTurn = turn({ 23: ['image/png', 'aGVsbG8='], 18: 12 });
  const emptyDraft = turn({ 0: '' });

  const runSettings = new Array(35).fill(null);
  runSettings[0] = 1;                       // temperature
  runSettings[2] = 'models/gemini-3-pro';
  runSettings[4] = 0.95;                    // topP
  runSettings[5] = 64;                      // topK
  runSettings[6] = 65536;                   // maxOutputTokens
  runSettings[7] = [[null, null, 7, 5], [null, null, 8, 5]];

  const metadata = new Array(12).fill(null);
  metadata[0] = 'Arithmetic Chat';
  metadata[4] = [[1784534516, 330000000], null];
  metadata[11] = [['promptType', 'CHUNKED_PROMPT'], ['hasImages', 'true']];

  const prompt = new Array(14).fill(null);
  prompt[0] = 'prompts/ABC123';
  prompt[3] = runSettings;
  prompt[4] = metadata;
  prompt[13] = [[userTurn, thoughtTurn, modelTurn, attachmentTurn, inlineFileTurn, emptyDraft], []];

  return [prompt];
}

// --- decoder ------------------------------------------------------------

test('decodes identity and title', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  assert.strictEqual(c.id, 'ABC123');
  assert.strictEqual(c.title, 'Arithmetic Chat');
  assert.strictEqual(c.source, 'api');
  assert.strictEqual(c.url, 'https://aistudio.google.com/prompts/ABC123');
});

test('maps temperature to index 0 and topP to index 4', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  assert.strictEqual(c.config.temperature, 1, 'temperature must come from runSettings[0]');
  assert.strictEqual(c.config.topP, 0.95, 'topP must come from runSettings[4]');
  assert.strictEqual(c.config.topK, 64);
  assert.strictEqual(c.config.maxOutputTokens, 65536);
  assert.strictEqual(c.config.model, 'models/gemini-3-pro');
  assert.strictEqual(c.config.safetySettings.length, 2);
});

test('separates thought turns from answers', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const thoughts = c.turns.filter((t) => t.isThought);
  const answers = c.turns.filter((t) => t.role === 'model' && !t.isThought);
  assert.strictEqual(thoughts.length, 1);
  assert.strictEqual(answers.length, 1);
  // The regression that motivated the rewrite: reasoning must never replace
  // the answer. Both survive as distinct turns.
  assert.strictEqual(thoughts[0].text, 'The user wants arithmetic.');
  assert.strictEqual(answers[0].text, 'It is 4.');
});

test('drops the trailing empty draft turn', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  assert.ok(c.turns.every((t) => t.text.trim() || t.parts.length), 'no contentless turns');
  assert.strictEqual(c.turns.length, 5);
});

test('decodes both drive-ref and inline attachments', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const parts = c.turns.flatMap((t) => t.parts);
  const byDrive = parts.find((p) => p.driveId);
  const inline = parts.find((p) => p.dataBase64);
  assert.ok(byDrive, 'drive-referenced attachment decoded');
  assert.strictEqual(byDrive.driveId.length, 33);
  assert.ok(inline, 'inline attachment decoded');
  assert.strictEqual(inline.type, 'image');
  assert.strictEqual(inline.mimeType, 'image/png');
});

test('computes stats from turns', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  assert.strictEqual(c.stats.userTurns, 3);
  assert.strictEqual(c.stats.modelTurns, 1);
  assert.strictEqual(c.stats.thoughtTurns, 1);
  assert.strictEqual(c.stats.totalTokens, 5 + 11 + 7 + 900 + 12);
  assert.strictEqual(c.stats.attachments, 2);
});

test('survives a renumbered wire format without throwing', () => {
  // Simulates Google moving fields: everything past the prompt array is junk.
  const mangled = [[('prompts/X'), null, null, 'not-an-array', null]];
  const c = AISE.decode.decodeConversation(mangled);
  assert.strictEqual(c.config, null);
  assert.strictEqual(c.turns.length, 0);
});

test('rejects an unrecognisable payload so the caller can fall back', () => {
  assert.throws(() => AISE.decode.decodeConversation([null]), /no prompt message/);
});

// --- settings gating ----------------------------------------------------

test('applySettings strips opted-out content and refreshes stats', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  AISE.model.applySettings(c, Object.assign({}, ALL_ON, {
    scrapeReasoning: false,
    includeModelConfig: false,
    includeTokenCounts: false,
  }));
  assert.strictEqual(c.stats.thoughtTurns, 0);
  assert.strictEqual(c.config, null);
  assert.strictEqual(c.stats.totalTokens, null, 'token total recomputed after counts removed');
});

// --- formatters ---------------------------------------------------------

test('markdown includes metadata and unambiguous turn delimiters', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const md = AISE.formats.markdown.render(c, ALL_ON, new Map());
  assert.ok(md.startsWith('# Arithmetic Chat'));
  assert.ok(md.includes('**Temperature:** 1'));
  assert.ok(md.includes('**Top P:** 0.95'));
  assert.ok(md.includes('<!-- aise:turn role=model thought=1 -->'));
  assert.ok(md.includes('## 🧠 Model (Reasoning)'));
  assert.ok(md.includes('It is 4.'));
});

test('markdown does not mangle message bodies that look like our own markup', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  c.turns[0].text = '## 👤 User\n---\nnot a real heading';
  const md = AISE.formats.markdown.render(c, ALL_ON, new Map());
  assert.ok(md.includes('## 👤 User\n---\nnot a real heading'), 'body preserved verbatim');
  // Delimiter count is what disambiguates, not escaping.
  assert.strictEqual((md.match(/<!-- aise:turn/g) || []).length, c.turns.length);
});

test('markdown records unretrievable attachments instead of dropping them', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const md = AISE.formats.markdown.render(c, ALL_ON, new Map());
  assert.ok(md.includes('file not retrievable'));
});

test('markdown honours settings gating', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  AISE.model.applySettings(c, Object.assign({}, ALL_ON, { includeModelConfig: false }));
  const md = AISE.formats.markdown.render(c, Object.assign({}, ALL_ON, { includeModelConfig: false }), new Map());
  assert.ok(!md.includes('**Temperature:**'));
});

test('json round-trips to valid parseable output', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const parsed = JSON.parse(AISE.formats.json.render(c, ALL_ON, new Map()));
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.title, 'Arithmetic Chat');
  assert.strictEqual(parsed.config.temperature, 1);
  assert.strictEqual(parsed.turns.length, 5);
  assert.strictEqual(parsed.turns[1].isThought, true);
});

test('json omits gated fields entirely rather than nulling them', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const settings = Object.assign({}, ALL_ON, { includeModelConfig: false, includeTokenCounts: false });
  const parsed = JSON.parse(AISE.formats.json.render(c, settings, new Map()));
  assert.ok(!('config' in parsed));
  assert.ok(!('tokenCount' in parsed.turns[0]));
});

test('text output carries no markdown markup', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const txt = AISE.formats.text.render(c, ALL_ON);
  assert.ok(txt.includes('MODEL (REASONING)'));
  assert.ok(txt.includes('Arithmetic Chat'));
  assert.ok(!txt.includes('<!--'), 'no HTML comment delimiters in plain text');
});

// --- report -------------------------------------------------------------

for (const { name, error } of failures) {
  console.error(`FAIL  ${name}\n      ${error.message}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
