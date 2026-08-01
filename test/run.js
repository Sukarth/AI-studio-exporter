/**
 * Test runner. No framework; the extension ships no build step and no
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

// The export pipeline reaches for browser globals at call time, not load time,
// so stubbing the handful it touches is enough to exercise its pure helpers.
globalThis.location = { href: 'https://aistudio.google.com/u/1/prompts/ABC123xyz789' };
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
globalThis.URL = globalThis.URL || { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };

load(
  'src/model.js',
  'src/api/decode.js',
  'src/api/attachments.js',
  'src/formats/markdown.js',
  'src/formats/json.js',
  'src/formats/text.js',
  'src/export.js',
  'pro/formats/jsonl.js',
  'pro/formats/csv.js',
  'pro/formats/html.js',
  'pro/formats/obsidian.js',
  'pro/batch.js'
);

const { AISE } = globalThis;

/**
 * settings.js is a plain script whose top-level `const` declarations become
 * global *lexical* bindings under eval; reachable by name from inside the same
 * script, but never as properties of globalThis. Appending an export statement
 * to the source is the only way to get at them from here.
 */
const SETTINGS = (0, eval)(
  fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8') +
    '\n;({ AI_STUDIO_FORMATS, AI_STUDIO_DEFAULT_SETTINGS, AI_STUDIO_FREE_FORMATS,' +
    ' sanitizeSettings, isAIStudioUrl, isAIStudioPromptUrl, isAIStudioLibraryUrl });'
);

const BOM = String.fromCharCode(0xfeff);

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

  // Streamed chunk. Index 1 is the text; index 12 marks it as reasoning.
  const part = (text, thought) => {
    const p = new Array(15).fill(null);
    p[1] = text;
    if (thought) p[12] = 1;
    return p;
  };

  const userTurn = turn({ 0: 'What is 2+2?', 18: 5, 32: [1784274199, 457000000] });
  // Reasoning: turn-level flag 16 is absent, and every part is marked.
  const thoughtTurn = turn({
    0: 'The user wants arithmetic.', 8: 'model', 18: 11,
    29: [part('The user wants arithmetic.', true)], 32: [1784274200, 0],
  });
  // Answer: flag 16 is set. Its polarity marks answers, not thoughts.
  const modelTurn = turn({
    0: 'It is 4.', 8: 'model', 16: 1, 18: 7,
    29: [part('It is 4.', false)], 32: [1784274201, 0],
  });
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

test('does not mistake an answer for reasoning when parts are absent', () => {
  // Observed live: a short exchange whose only model turn carries flag 16 and
  // holds the answer. Reading flag 16 as isThought filed every answer under
  // reasoning, which is exactly what the first real export produced.
  const bare = new Array(36).fill(null);
  bare[8] = 'model';
  bare[16] = 1;
  bare[0] = 'aistudio-ok-3';
  const prompt = new Array(14).fill(null);
  prompt[0] = 'prompts/X';
  prompt[13] = [[bare], []];

  const c = AISE.decode.decodeConversation([prompt]);
  assert.strictEqual(c.turns.length, 1);
  assert.strictEqual(c.turns[0].isThought, false, 'flag 16 marks the answer, not a thought');
  assert.strictEqual(c.stats.modelTurns, 1);
  assert.strictEqual(c.stats.thoughtTurns, 0);
});

test('treats a partless model turn without flag 16 as reasoning', () => {
  const bare = new Array(36).fill(null);
  bare[8] = 'model';
  bare[0] = 'Thinking about it.';
  const prompt = new Array(14).fill(null);
  prompt[0] = 'prompts/X';
  prompt[13] = [[bare], []];

  const c = AISE.decode.decodeConversation([prompt]);
  assert.strictEqual(c.turns[0].isThought, true);
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

/** Three attachment-only turns followed by the message they were sent with. */
function attachmentRun() {
  const c = AISE.model.emptyConversation('ABC123', 'api');
  const attach = (driveId, tokens, type) =>
    AISE.model.makeTurn('user', '', {
      tokenCount: tokens,
      parts: [{ type, name: `${driveId}.bin`, driveId, byteLength: 10 }],
    });

  c.turns = [
    attach('one', 100, 'image'),
    attach('two', 200, 'file'),
    attach('three', 300, 'image'),
    AISE.model.makeTurn('user', 'What do you make of these?', { tokenCount: 7 }),
    AISE.model.makeTurn('model', 'Three files.', { tokenCount: 3 }),
  ];
  return AISE.model.recomputeStats(c);
}

test('folds attachment-only turns into the message they were sent with', () => {
  // AI Studio files every attachment as its own turn, so a real export showed
  // three headed blocks containing nothing but a token count.
  const c = attachmentRun();
  AISE.model.applySettings(c, ALL_ON);

  assert.strictEqual(c.turns.length, 2, 'four user turns became one');
  assert.strictEqual(c.turns[0].text, 'What do you make of these?');
  assert.strictEqual(c.turns[0].parts.length, 3, 'every attachment came along');
  assert.strictEqual(c.turns[0].tokenCount, 100 + 200 + 300 + 7, 'and so did their tokens');
});

test('keeps attachment order when folding', () => {
  const c = attachmentRun();
  AISE.model.applySettings(c, ALL_ON);
  assert.deepStrictEqual(c.turns[0].parts.map((p) => p.driveId), ['one', 'two', 'three']);
});

test('leaves AI Studio structure alone when condensing is off', () => {
  const c = attachmentRun();
  AISE.model.applySettings(c, Object.assign({}, ALL_ON, { condenseAttachments: false }));
  assert.strictEqual(c.turns.length, 5);
});

test('counts excluded attachments instead of leaving an empty message', () => {
  // Exporting images only used to produce a run of headings with no content,
  // because the file turns were emptied but kept.
  const c = attachmentRun();
  AISE.model.applySettings(c, Object.assign({}, ALL_ON, { scrapeAttachments: false }));

  assert.strictEqual(c.turns[0].parts.length, 2, 'the two images survive');
  assert.strictEqual(c.turns[0].excludedAttachments, 1, 'the file is counted, not forgotten');
});

test('markdown says what was left out rather than showing a bare heading', () => {
  const c = attachmentRun();
  AISE.model.applySettings(c, Object.assign({}, ALL_ON, {
    scrapeImages: false,
    scrapeAttachments: false,
  }));
  const md = AISE.formats.markdown.render(c, ALL_ON, new Map());
  assert.ok(md.includes('3 attachments not included in export'), md);
});

test('every formatter discloses excluded attachments', () => {
  const c = attachmentRun();
  AISE.model.applySettings(c, Object.assign({}, ALL_ON, {
    scrapeImages: false,
    scrapeAttachments: false,
  }));

  for (const id of ['markdown', 'text', 'html', 'obsidian']) {
    const rendered = AISE.formats[id].render(c, ALL_ON, new Map());
    assert.ok(/3 attachments not included/.test(rendered), `${id} omits the disclosure`);
  }
  const json = JSON.parse(AISE.formats.json.render(c, ALL_ON, new Map()));
  assert.strictEqual(json.turns[0].excludedAttachments, 3);
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

// --- attachment naming --------------------------------------------------

const { chooseFilename } = AISE.attachments;

test('keeps a filename that already has a usable extension', () => {
  assert.strictEqual(chooseFilename('notes.pdf', 'application/pdf', null), 'notes.pdf');
});

test('appends an extension derived from MIME when the name lacks one', () => {
  assert.strictEqual(chooseFilename('notes', 'text/markdown', null), 'notes.md');
  assert.strictEqual(chooseFilename('sheet', 'text/csv', null), 'sheet.csv');
});

test('rewrites the extension when a native doc was exported to another format', () => {
  // A Google Doc named "Report" exported as PDF must not be saved as "Report.md".
  assert.strictEqual(chooseFilename('Report.gdoc', 'application/pdf', 'pdf'), 'Report.pdf');
  assert.strictEqual(chooseFilename('Report', 'text/markdown', 'md'), 'Report.md');
});

test('strips path separators that would escape the archive directory', () => {
  const name = chooseFilename('../../etc/passwd', 'text/plain', null);
  assert.ok(!name.includes('/'), 'no forward slash survives');
  assert.ok(!name.includes('\\'), 'no backslash survives');
});

test('falls back to a generic name and extension for unknown types', () => {
  assert.strictEqual(chooseFilename('', 'application/x-unknown-thing', null), 'attachment.bin');
});

// --- export pipeline ----------------------------------------------------

const { currentPromptId, safeFilename, buildBaseName, planAssets } = AISE.exporter;

test('extracts the prompt id from both plain and account-scoped URLs', () => {
  assert.strictEqual(currentPromptId('https://aistudio.google.com/prompts/ABC123xyz789'), 'ABC123xyz789');
  assert.strictEqual(currentPromptId('https://aistudio.google.com/u/3/prompts/ABC123xyz789'), 'ABC123xyz789');
  assert.strictEqual(currentPromptId('https://aistudio.google.com/library'), null);
});

test('strips characters that are illegal in filenames', () => {
  const name = safeFilename('Report: drafts/v2 "final" <x>?');
  for (const ch of ['/', '\\', ':', '"', '<', '>', '?', '*', '|', '%']) {
    assert.ok(!name.includes(ch), `"${ch}" must not survive`);
  }
});

test('never produces a leading-dot or empty filename', () => {
  assert.ok(!safeFilename('...').startsWith('.'));
  assert.strictEqual(safeFilename(''), 'conversation');
  assert.strictEqual(safeFilename('///'), 'conversation');
});

test('strips control characters from filenames', () => {
  const withControls = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(31) + 'c';
  assert.strictEqual(safeFilename(withControls), 'a-b-c');
});

test('escapes Windows reserved device names', () => {
  // "CON.md" cannot be created on Windows whatever the extension.
  assert.strictEqual(safeFilename('CON'), 'CON-export');
  assert.strictEqual(safeFilename('lpt1'), 'lpt1-export');
  assert.strictEqual(safeFilename('console'), 'console');
});

test('source files contain no literal control characters', () => {
  // A regex written with a raw NUL byte once made it into src/export.js, where
  // it was invisible in review and silently changed which characters the
  // filename sanitiser matched. Escapes only, from here on.
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
      return /\.(js|json|html)$/.test(entry.name) ? [full] : [];
    });

  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'test'))]
    .concat(['content.js', 'settings.js', 'popup.js', 'options.js', 'background.js', 'manifest.json']
      .map((f) => path.join(ROOT, f))
      .filter((f) => fs.existsSync(f)));

  const dirty = files.filter((file) => {
    const buf = fs.readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
    }
    return false;
  });

  assert.deepStrictEqual(dirty.map((f) => path.relative(ROOT, f)), [], 'files with control characters');
});

test('manifest host permissions cover every origin the code fetches', () => {
  // A missing host permission is a CORS failure at runtime with a message that
  // points at the wrong thing entirely.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const granted = manifest.host_permissions.map((p) => new URL(p.replace(/\*$/, '')).origin);

  // Only files that fetch with the extension's own privileges. src/api/rpc.js
  // is deliberately absent: it runs in the page's MAIN world, so its requests
  // to MakerSuite and Drive are page-origin requests governed by those APIs'
  // CORS headers. Granting host permissions for them would be asking for
  // access the extension does not use.
  const sources = ['pro/license.js', 'background.js', 'pro/schedule.js']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f));

  const wanted = new Set();
  for (const file of sources) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      const origin = `https://${match[1]}`;
      // Only origins the extension actually calls, not ones it merely names.
      if (/googleapis\.com|polar\.sh|clients6\.google\.com/.test(origin)) wanted.add(origin);
    }
  }

  const missing = [...wanted].filter((origin) => !granted.includes(origin));
  assert.deepStrictEqual(missing, [], 'origins fetched without a host permission');
});

test('every element the popup and options pages reach for exists in their HTML', () => {
  // Extension pages cannot be driven by devtools automation, so a typo'd id
  // shows up as a silent null.addEventListener at boot with nothing in the
  // page console anyone is looking at. Cheaper to pin it here.
  const pages = [['popup.js', 'popup.html'], ['options.js', 'options.html']];

  for (const [script, markup] of pages) {
    const js = fs.readFileSync(path.join(ROOT, script), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, markup), 'utf8');

    const declared = new Set();
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) declared.add(match[1]);

    const wanted = new Set();
    for (const match of js.matchAll(/getElementById\('([^']+)'\)/g)) wanted.add(match[1]);
    // Both pages go through a one-letter helper as well: el('backupFormat'),
    // $('formatList'). Without these the check quietly stops checking.
    // `\b` before `$` would never match, since `$` is not a word character.
    for (const match of js.matchAll(/(?:\bel|\$)\('([^']+)'\)/g)) wanted.add(match[1]);

    const missing = [...wanted].filter((id) => !declared.has(id));
    assert.deepStrictEqual(missing, [], `${script} references ids absent from ${markup}`);
    assert.ok(wanted.size > 5, `${script}: found only ${wanted.size} ids, the pattern has stopped matching`);
  }
});

test('the options page renders a control for every boolean setting', () => {
  // The checkbox bindings are derived from the defaults, so a setting added
  // without markup is saved as false forever and never surfaces.
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const booleans = Object.keys(SETTINGS.AI_STUDIO_DEFAULT_SETTINGS).filter(
    (key) => typeof SETTINGS.AI_STUDIO_DEFAULT_SETTINGS[key] === 'boolean'
  );
  const missing = booleans.filter((key) => !html.includes(`id="${key}"`));
  assert.deepStrictEqual(missing, [], 'boolean settings with no checkbox');
});

test('archive name leads with the conversation title', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  assert.ok(buildBaseName(c).startsWith('Arithmetic Chat'), 'title first, not a bare timestamp');
});

test('asset planning de-duplicates colliding attachment names', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  // Two attachments that would both land on the same archive path.
  const parts = c.turns.flatMap((t) => t.parts);
  parts.forEach((p) => { p.name = 'notes.txt'; p.mimeType = 'text/plain'; p.buffer = new ArrayBuffer(4); });

  const { files, assetPaths } = planAssets(c);
  const paths = files.map((f) => f.path);
  assert.strictEqual(new Set(paths).size, paths.length, 'every archive path is unique');
  assert.strictEqual(assetPaths.size, files.length);
  assert.ok(paths.every((p) => p.startsWith('attachments/')));
});

test('asset planning skips parts that have no bytes', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  // Only the inline attachment carries data; the drive-referenced one does not.
  const { files } = planAssets(c);
  assert.strictEqual(files.length, 1, 'unfetched drive refs are not archive entries');
});

// --- pro formatters -----------------------------------------------------

test('jsonl emits one training example in the messages format', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const lines = AISE.formats.jsonl.render(c, ALL_ON).trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.ok(Array.isArray(parsed.messages));
  assert.ok(parsed.messages.some((m) => m.role === 'assistant'));
});

test('jsonl excludes reasoning unless explicitly opted in', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  // Training on private thinking as if it were the reply teaches the model to
  // emit thinking as output.
  const without = JSON.parse(AISE.formats.jsonl.render(c, ALL_ON));
  assert.ok(!JSON.stringify(without).includes('The user wants arithmetic.'));

  const with_ = JSON.parse(AISE.formats.jsonl.render(c, Object.assign({}, ALL_ON, { jsonlIncludeReasoning: true })));
  assert.ok(JSON.stringify(with_).includes('The user wants arithmetic.'));
});

test('jsonl merges consecutive same-role turns', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const messages = AISE.formats.jsonl.toMessages(c, { includeReasoning: false });
  for (let i = 1; i < messages.length; i++) {
    assert.notStrictEqual(messages[i].role, messages[i - 1].role, 'roles must alternate');
  }
});

test('jsonl skips a conversation with no assistant reply', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  c.turns = c.turns.filter((t) => t.role === 'user');
  assert.strictEqual(AISE.formats.jsonl.render(c, ALL_ON), '');
});

test('csv neutralises formula injection', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  c.turns[0].text = '=cmd|/c calc!A1';
  const csv = AISE.formats.csv.render(c, ALL_ON);
  assert.ok(csv.includes('"\'=cmd'), 'leading = is prefixed so Excel treats it as text');
});

test('csv quotes embedded quotes and newlines', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  c.turns[0].text = 'say "hi"\nthen stop';
  const csv = AISE.formats.csv.render(c, ALL_ON);
  assert.ok(csv.includes('""hi""'), 'quotes are doubled per RFC 4180');
});

test('every concatenable format declares the preamble batch export must strip', () => {
  // Whole-library export glues these together into a single dataset file. Any
  // per-conversation preamble has to be declared so it appears once; a CSV
  // whose header row repeats every few hundred lines is not a dataset.
  const c = AISE.decode.decodeConversation(wirePrompt());
  for (const format of Object.values(AISE.formats)) {
    if (!format.concatenable) continue;
    const rendered = format.render(c, ALL_ON, new Map());
    if (!format.preamble) {
      assert.ok(
        !rendered.startsWith(BOM),
        `${format.id} emits a BOM but declares no preamble`
      );
      continue;
    }
    assert.ok(rendered.startsWith(format.preamble), `${format.id} does not start with its own preamble`);
  }
});

test('csv carries its BOM and header in the declared preamble', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const csv = AISE.formats.csv.render(c, ALL_ON);
  const { preamble } = AISE.formats.csv;

  assert.ok(preamble.startsWith(BOM), 'BOM lives in the preamble');
  assert.ok(preamble.includes('"conversation_id"'), 'so does the header row');
  // What batch export does to the second and later conversations.
  assert.ok(!csv.slice(preamble.length).includes('"conversation_id"'), 'header appears once');
});

test('markdown link targets survive a filename containing brackets', () => {
  // Found on a real export: colliding attachment names get a " (2)" suffix
  // from planAssets, encodeURI leaves parentheses alone, and every Markdown
  // parser then ends the link at the first ")". 12 of 42 links pointed at
  // nothing.
  const c = AISE.decode.decodeConversation(wirePrompt());
  const part = c.turns.flatMap((t) => t.parts)[0];
  part.name = 'report (2).pdf';
  part.type = 'file';

  const paths = new Map([[part, 'attachments/report (2).pdf']]);
  const md = AISE.formats.markdown.render(c, ALL_ON, paths);

  const target = /\]\(([^)\s]*)\)/.exec(md.slice(md.indexOf('attachments') - 40));
  assert.ok(target, 'no link found');
  assert.ok(!/\(|\)/.test(target[1]), `unescaped parenthesis in ${target[1]}`);
  assert.ok(target[1].includes('%282%29'), target[1]);
});

test('markdown link targets escape fragment and query characters', () => {
  const { escapeTarget } = AISE.formats.markdown;
  assert.strictEqual(escapeTarget('attachments/a#b.png'), 'attachments/a%23b.png');
  assert.strictEqual(escapeTarget('attachments/a?b.png'), 'attachments/a%3Fb.png');
  // Spaces still go through encodeURI, and the separator must stay a separator.
  assert.strictEqual(escapeTarget('attachments/a b.png'), 'attachments/a%20b.png');
});

test('the library index escapes its folder names too', () => {
  // makeFolderNamer appends "(abc123)" when two conversations share a title.
  const index = AISE.batch.buildIndexMarkdown(
    [{ title: 'Notes', path: 'Notes (a1b2c3)/conversation.md', modifiedAt: 0, turnCount: 2 }],
    [],
    0
  );
  const target = /\]\(([^)\s]*)\)/.exec(index);
  assert.ok(target, 'no link in the index');
  assert.ok(!/\(|\)/.test(target[1]), `unescaped parenthesis in ${target[1]}`);
});

test('html escapes message content rather than rendering it', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  c.turns[0].text = '<script>alert(1)</script>';
  const html = AISE.formats.html.render(c, ALL_ON, new Map());
  assert.ok(!html.includes('<script>alert(1)</script>'), 'no live script element');
  assert.ok(html.includes('&lt;script&gt;'), 'shown as text instead');
});

test('html refuses javascript: links from message text', () => {
  const escaped = AISE.formats.html.escapeHtml('[click](javascript:alert(1))');
  const rendered = AISE.formats.html.renderMarkdown(escaped);
  assert.ok(!/href="javascript:/i.test(rendered), 'only http(s) links become anchors');
});

test('html renders fenced code without letting it escape the block', () => {
  const escaped = AISE.formats.html.escapeHtml('```js\nconst a = 1 < 2;\n```');
  const rendered = AISE.formats.html.renderMarkdown(escaped);
  assert.ok(rendered.includes('<pre'), 'fence became a pre block');
  assert.ok(rendered.includes('&lt;'), 'angle bracket stayed escaped');
});

test('html renders a heading followed immediately by text', () => {
  // The old block parser tested each blank-line-separated chunk as a whole, so
  // a heading with prose on the next line stayed literal "## ..." on the page.
  const html = AISE.formats.html.renderMarkdown(
    AISE.formats.html.escapeHtml('## Results\nThe model improved.')
  );
  assert.ok(/<h3>Results<\/h3>/.test(html), html);
  assert.ok(!html.includes('## Results'), 'heading markup left as text');
});

test('html renders a markdown table as a table', () => {
  // Left as plain text, a wide table was what pushed content past the page.
  const source = '| Epsilon | Accuracy |\n|---|---|\n| 0 | 96.28% |\n| 0.04 | 47.24% |';
  const html = AISE.formats.html.renderMarkdown(AISE.formats.html.escapeHtml(source));
  assert.ok(html.includes('<table>'), html);
  assert.ok(html.includes('<th>Epsilon</th>'), 'header cells');
  assert.ok(html.includes('<td>96.28%</td>'), 'body cells');
  assert.ok(html.includes('class="table-wrap"'), 'wrapped so it scrolls rather than overflows');
});

test('html renders ordered lists and blockquotes', () => {
  const { escapeHtml, renderMarkdown } = AISE.formats.html;
  assert.ok(renderMarkdown(escapeHtml('1. first\n2. second')).includes('<ol>'));
  // ">" is "&gt;" by the time the block parser sees it.
  assert.ok(renderMarkdown(escapeHtml('> quoted line')).includes('<blockquote>'));
});

test('html collapses reasoning behind a disclosure', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const html = AISE.formats.html.render(c, ALL_ON, new Map());
  assert.ok(html.includes('<details class="thought">'), 'reasoning is a details element');
  assert.ok(!/<details class="thought"[^>]*\bopen\b/.test(html), 'and starts closed');
  // The answer must never be hidden.
  assert.ok(html.includes('<article class="turn model">'), 'answers stay open');
});

test('html stacks attachment links instead of lining them up', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const part = c.turns.flatMap((t) => t.parts).find((p) => p.driveId);
  part.name = 'notes.pdf';
  part.type = 'file';
  const html = AISE.formats.html.render(c, ALL_ON, new Map([[part, 'attachments/notes.pdf']]));
  assert.ok(html.includes('class="attachments"'), 'links share a column container');
});

test('html keeps long unbroken text inside the page', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const html = AISE.formats.html.render(c, ALL_ON, new Map());
  assert.ok(/overflow-wrap:anywhere/.test(html), 'prose wraps rather than overflowing');
  assert.ok(/\.table-wrap\s*\{[^}]*overflow-x:auto/.test(html), 'tables scroll in their own box');
});

test('html output is a complete standalone document', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const html = AISE.formats.html.render(c, ALL_ON, new Map());
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<style>'), 'CSS is inlined');
  assert.ok(!/<(script|link)\b[^>]*\bsrc=|<link\b[^>]*\bhref="http/i.test(html), 'nothing loaded externally');
});

test('obsidian frontmatter survives a title containing quotes', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  c.title = 'He said "hello": a study';
  const md = AISE.formats.obsidian.render(c, ALL_ON, new Map());
  const frontmatter = md.split('---')[1];
  assert.ok(frontmatter.includes('\\"hello\\"'), 'quotes escaped inside the YAML scalar');
});

test('obsidian wraps reasoning in a collapsed callout', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const md = AISE.formats.obsidian.render(c, ALL_ON, new Map());
  assert.ok(md.includes('> [!note]- 🧠 Reasoning'));
});

test('obsidian links attachments by vault basename, not archive path', () => {
  const c = AISE.decode.decodeConversation(wirePrompt());
  const part = c.turns.flatMap((t) => t.parts)[0];
  const md = AISE.formats.obsidian.render(c, ALL_ON, new Map([[part, 'attachments/photo.png']]));
  assert.ok(md.includes('[[photo.png]]'), 'basename only');
  assert.ok(!md.includes('[[attachments/photo.png]]'));
});

test('every pro format is flagged pro and every free format is not', () => {
  for (const id of ['markdown', 'json', 'text']) {
    assert.strictEqual(AISE.formats[id].pro, false, `${id} must stay free`);
  }
  for (const id of ['jsonl', 'csv', 'html', 'obsidian']) {
    assert.strictEqual(AISE.formats[id].pro, true, `${id} must be gated`);
  }
});

// --- batch --------------------------------------------------------------

const { selectConversations, makeFolderNamer, buildIndexMarkdown } = AISE.batch;

const DAY = 24 * 60 * 60 * 1000;
const libraryIndex = () => [
  { id: 'aaa111', title: 'Alpha', modifiedAt: Date.now() - 1 * DAY },
  { id: 'bbb222', title: 'Beta notes', modifiedAt: Date.now() - 10 * DAY },
  { id: 'ccc333', title: 'Alpha', modifiedAt: Date.now() - 40 * DAY },
  { id: 'ddd444', title: 'Gamma', modifiedAt: null },
];

test('filters the library by date range', () => {
  const picked = selectConversations(libraryIndex(), { since: Date.now() - 20 * DAY });
  assert.deepStrictEqual(picked.map((c) => c.id), ['aaa111', 'bbb222']);
});

test('filters by title substring, case-insensitively', () => {
  const picked = selectConversations(libraryIndex(), { titleQuery: 'alpha' });
  assert.deepStrictEqual(picked.map((c) => c.id).sort(), ['aaa111', 'ccc333']);
});

test('sorts newest first and honours a limit', () => {
  const picked = selectConversations(libraryIndex(), { limit: 2 });
  assert.deepStrictEqual(picked.map((c) => c.id), ['aaa111', 'bbb222']);
});

test('incremental filter skips conversations unchanged since last export', () => {
  const index = libraryIndex();
  // Pretend Alpha was exported after its last modification, Beta before.
  const seen = { aaa111: index[0].modifiedAt + 1000, bbb222: index[1].modifiedAt - 1000 };
  const picked = selectConversations(index, { skipUnchangedSince: seen });
  assert.ok(!picked.some((c) => c.id === 'aaa111'), 'unchanged conversation skipped');
  assert.ok(picked.some((c) => c.id === 'bbb222'), 'modified conversation included');
  assert.ok(picked.some((c) => c.id === 'ccc333'), 'never-exported conversation included');
});

test('folder naming disambiguates identical titles', () => {
  const name = makeFolderNamer();
  const first = name({ title: 'Alpha', id: 'aaa111aaa' });
  const second = name({ title: 'Alpha', id: 'ccc333ccc' });
  assert.strictEqual(first, 'Alpha');
  assert.notStrictEqual(second, first, 'second Alpha must not collide');
  assert.ok(second.includes('ccc333'), 'disambiguated with the id');
});

test('folder naming sanitises titles into safe paths', () => {
  const name = makeFolderNamer();
  const folder = name({ title: '../../etc/passwd', id: 'xxx' });
  assert.ok(!folder.includes('/'), 'no path separators');
  assert.ok(!folder.includes('\\'));
});

test('index lists every conversation and reports failures separately', () => {
  const entries = [
    { title: 'Alpha', path: 'Alpha/conversation.md', modifiedAt: Date.now(), turnCount: 4 },
  ];
  const failures = [{ id: 'zzz', title: 'Broken', error: 'Requested entity was not found.' }];
  const md = buildIndexMarkdown(entries, failures, Date.now());

  assert.ok(md.includes('[Alpha](Alpha/conversation.md)'));
  assert.ok(md.includes('**Conversations:** 1'));
  assert.ok(md.includes('## Not exported'), 'failures get their own section');
  assert.ok(md.includes('Broken'), 'a failed conversation is still named');
});

test('index escapes paths containing spaces', () => {
  const entries = [{ title: 'My Chat', path: 'My Chat/conversation.md', modifiedAt: null, turnCount: 1 }];
  const md = buildIndexMarkdown(entries, [], Date.now());
  assert.ok(md.includes('My%20Chat/conversation.md'), 'link target is URI-encoded');
});

// --- settings and format catalogue --------------------------------------

test('the UI format catalogue matches the registered formatters', () => {
  // settings.js mirrors format metadata so extension pages need not load every
  // renderer. If they drift, the popup offers formats that do not exist.
  const catalogue = SETTINGS.AI_STUDIO_FORMATS;
  const registered = Object.keys(AISE.formats);

  for (const entry of catalogue) {
    assert.ok(registered.includes(entry.id) || entry.id === 'pdf' || entry.id === 'docx',
      `catalogue lists ${entry.id} but no formatter registers it`);
  }
  for (const id of registered) {
    assert.ok(catalogue.some((entry) => entry.id === id), `${id} is registered but missing from the catalogue`);
  }
  for (const entry of catalogue) {
    const format = AISE.formats[entry.id];
    if (format) {
      assert.strictEqual(entry.pro, format.pro, `${entry.id} pro flag disagrees between catalogue and formatter`);
    }
  }
});

test('sanitizeSettings rejects a format id that is not a plausible slug', () => {
  const sanitized = SETTINGS.sanitizeSettings({ defaultFormat: '../../etc/passwd' });
  assert.strictEqual(sanitized.defaultFormat, 'markdown');
});

test('sanitizeSettings clamps the load delay to a sane range', () => {
  assert.strictEqual(SETTINGS.sanitizeSettings({ loadDelay: 50 }).loadDelay, 700);
  assert.strictEqual(SETTINGS.sanitizeSettings({ loadDelay: 999999 }).loadDelay, 700);
  assert.strictEqual(SETTINGS.sanitizeSettings({ loadDelay: 1200 }).loadDelay, 1200);
});

test('url helpers separate prompt pages from the rest of AI Studio', () => {
  const { isAIStudioUrl, isAIStudioPromptUrl, isAIStudioLibraryUrl } = SETTINGS;
  assert.ok(isAIStudioPromptUrl('https://aistudio.google.com/prompts/ABC'));
  assert.ok(isAIStudioPromptUrl('https://aistudio.google.com/u/2/prompts/ABC'));
  assert.ok(!isAIStudioPromptUrl('https://aistudio.google.com/library'));
  assert.ok(isAIStudioLibraryUrl('https://aistudio.google.com/u/1/library'));
  assert.ok(isAIStudioUrl('https://aistudio.google.com/anything'));
  // Must not be fooled by a lookalike host.
  assert.ok(!isAIStudioUrl('https://aistudio.google.com.evil.test/prompts/ABC'));
  assert.ok(!isAIStudioUrl('http://aistudio.google.com/prompts/ABC'), 'http is rejected');
});

// --- documentation ------------------------------------------------------
//
// Docs that describe fields drift the moment a field is added, and nothing
// else in the suite would notice. These assert coverage, not prose.

test('every setting is documented', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'settings.md'), 'utf8');
  const undocumented = Object.keys(SETTINGS.AI_STUDIO_DEFAULT_SETTINGS)
    .filter((key) => !docs.includes(key));
  assert.deepStrictEqual(undocumented, [], 'settings missing from docs/settings.md');
});

test('every format is documented', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'formats.md'), 'utf8');
  const undocumented = SETTINGS.AI_STUDIO_FORMATS
    .filter((entry) => !new RegExp(`#${entry.id}\\b|\\b${entry.id}\\b`, 'i').test(docs))
    .map((entry) => entry.id);
  assert.deepStrictEqual(undocumented, [], 'formats missing from docs/formats.md');
});

test('every documented JSON field is one the formatter emits', () => {
  // The reverse direction: a field renamed in code leaves the docs describing
  // something that no longer exists, which is worse than an omission.
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'data-reference.md'), 'utf8');
  const conversation = AISE.model.emptyConversation('ABC123', 'api');
  conversation.config = {
    model: 'models/gemini-3-pro', temperature: 1, topP: 0.95, topK: 64,
    maxOutputTokens: 1024, safetySettings: [],
  };
  conversation.systemInstruction = 'Be brief.';
  conversation.modifiedAt = 1750000000000;
  conversation.turns = [
    AISE.model.makeTurn('user', 'Hi', { tokenCount: 1, timestamp: 1750000000000 }),
    AISE.model.makeTurn('model', 'Hello', { tokenCount: 1 }),
  ];
  conversation.turns[0].parts = [
    { type: 'file', name: 'a.txt', mimeType: 'text/plain', driveId: 'x', byteLength: 3 },
  ];
  AISE.model.recomputeStats(conversation);
  const payload = JSON.parse(
    AISE.formats.json.render(conversation, ALL_ON, new Map([[conversation.turns[0].parts[0], 'attachments/a.txt']]))
  );

  const emitted = new Set([
    ...Object.keys(payload),
    ...Object.keys(payload.config),
    ...Object.keys(payload.stats),
    ...Object.keys(payload.turns[0]),
    ...Object.keys(payload.turns[0].parts[0]),
    'excludedAttachments', // only emitted when non-zero
  ]);

  // Every `| \`name\` |` row in the JSON section must name a real field.
  const jsonSection = docs.slice(docs.indexOf('## JSON'), docs.indexOf('## JSONL'));
  const claimed = [...jsonSection.matchAll(/^\| `([A-Za-z][\w.]*)` \|/gm)].map((m) => m[1]);
  assert.ok(claimed.length > 20, `expected a full field table, found ${claimed.length} rows`);

  const stale = claimed.filter((name) => !emitted.has(name) && !name.includes('.'));
  assert.deepStrictEqual(stale, [], 'documented JSON fields the formatter does not emit');
});

// --- report -------------------------------------------------------------

for (const { name, error } of failures) {
  console.error(`FAIL  ${name}\n      ${error.message}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
