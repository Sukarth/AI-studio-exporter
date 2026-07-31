/**
 * Integration test for whole-library export.
 *
 * Separate from test/run.js because it drives the real pipeline end to end —
 * JSZip, async rendering, archive generation — rather than the pure helpers.
 * The API and the download are the only things faked, so everything between
 * "here is a library index" and "here are the bytes of a ZIP" is genuinely
 * exercised, including the paths that only misbehave at scale: name
 * collisions, a conversation that throws, and concatenated dataset formats.
 *
 * @license MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

globalThis.location = { href: 'https://aistudio.google.com/u/1/prompts/ABC' };
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

const load = (...rels) => {
  for (const rel of rels) (0, eval)(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
};

load(
  'libs/jszip.min.js',
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

const SETTINGS = {
  scrapeImages: false,
  scrapeAttachments: false,
  scrapeReasoning: true,
  includeSystemInstruction: true,
  includeModelConfig: true,
  includeTimestamps: true,
  includeTokenCounts: true,
  includeSourceUrl: true,
};

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push({ name, error });
  }
}

// --- fake API -----------------------------------------------------------

/**
 * Three conversations, two of which share a title so the folder namer has to
 * disambiguate, plus one that cannot be fetched.
 */
const LIBRARY = [
  { id: 'aaa111', title: 'Weekly Notes', modifiedAt: 1780000003000 },
  { id: 'bbb222', title: 'Weekly Notes', modifiedAt: 1780000002000 },
  { id: 'ccc333', title: 'Broken One', modifiedAt: 1780000001000 },
];

function conversationFor(summary) {
  const c = AISE.model.emptyConversation();
  c.id = summary.id;
  c.title = summary.title;
  c.modifiedAt = summary.modifiedAt;
  c.url = `https://aistudio.google.com/prompts/${summary.id}`;

  c.turns = [
    AISE.model.makeTurn('user', `Question in ${summary.id}`),
    AISE.model.makeTurn('model', `Answer in ${summary.id}`),
  ];
  AISE.model.recomputeStats(c);
  return c;
}

const downloads = [];
AISE.exporter.triggerDownload = (blob, filename) => downloads.push({ blob, filename });

AISE.api = {
  listAllPrompts: async () => LIBRARY,
  fetchConversation: async (id) => {
    if (id === 'ccc333') throw new Error('Prompt unavailable');
    return conversationFor(LIBRARY.find((c) => c.id === id));
  },
};

const runLibrary = (formatId, filters) => {
  downloads.length = 0;
  return AISE.batch.exportLibrary({ settings: SETTINGS, formatId, filters: filters || {}, report: () => {} });
};

/** Read a generated archive back out as { path: text }. */
async function readArchive(blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    out[name] = await zip.files[name].async('string');
  }
  return out;
}

// --- tests --------------------------------------------------------------

async function main() {
  await test('produces one archive containing every conversation that could be read', async () => {
    const result = await runLibrary('markdown');
    assert.strictEqual(result.success, true);
    assert.strictEqual(downloads.length, 1, 'one archive');

    const files = await readArchive(downloads[0].blob);
    const conversations = Object.keys(files).filter((f) => f.endsWith('conversation.md'));
    assert.strictEqual(conversations.length, 2, 'both readable conversations landed');
    assert.ok(files['index.md'], 'index written');
    assert.ok(files['manifest.json'], 'manifest written');
  });

  await test('disambiguates conversations that share a title', async () => {
    await runLibrary('markdown');
    const files = await readArchive(downloads[0].blob);
    const folders = Object.keys(files)
      .filter((f) => f.includes('/'))
      .map((f) => f.split('/')[0]);
    assert.strictEqual(new Set(folders).size, folders.length, 'every folder name is unique');
  });

  await test('reports a failed conversation without losing the others', async () => {
    const result = await runLibrary('markdown');
    assert.strictEqual(result.failures.length, 1);
    assert.strictEqual(result.failures[0].id, 'ccc333');

    const files = await readArchive(downloads[0].blob);
    const manifest = JSON.parse(files['manifest.json']);
    assert.strictEqual(manifest.failures.length, 1, 'the failure is in the manifest, not just the return value');
    assert.ok(files['index.md'].includes('Broken One'), 'and named in the human-readable index');
  });

  await test('only marks successfully exported conversations as backed up', async () => {
    // Scheduled backups skip anything in exportedAt. A failure recorded here
    // would never be retried.
    const result = await runLibrary('markdown');
    assert.deepStrictEqual(Object.keys(result.exportedAt).sort(), ['aaa111', 'bbb222']);
  });

  await test('emits the CSV header exactly once across the whole library', async () => {
    const result = await runLibrary('csv');
    assert.strictEqual(downloads.length, 1);
    assert.ok(downloads[0].filename.endsWith('.csv'), 'a dataset file, not an archive');

    // Blob.text() strips a leading BOM, which is exactly the byte under test,
    // so decode the raw bytes instead.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      await downloads[0].blob.arrayBuffer()
    );
    const headers = text.split('"conversation_id"').length - 1;
    assert.strictEqual(headers, 1, 'one header row for the whole file');
    assert.strictEqual(text.split(String.fromCharCode(0xfeff)).length - 1, 1, 'one BOM');
    assert.ok(text.includes('aaa111') && text.includes('bbb222'), 'both conversations present');
    assert.strictEqual(result.message.includes('2 conversations'), true, result.message);
  });

  await test('concatenates JSONL into a single dataset file', async () => {
    await runLibrary('jsonl');
    const text = await downloads[0].blob.text();
    const lines = text.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, 'one JSON object per conversation');
    for (const line of lines) JSON.parse(line);
  });

  await test('honours the incremental filter scheduled backups rely on', async () => {
    const result = await runLibrary('markdown', {
      skipUnchangedSince: { aaa111: 1780000003000, bbb222: 1780000002000, ccc333: 1780000001000 },
    });
    assert.strictEqual(result.success, false, 'nothing changed, so nothing to do');
    assert.strictEqual(downloads.length, 0, 'and no empty archive downloaded');
  });

  await test('surfaces a format warning once for the whole run', async () => {
    // A single export reports this as it happens. A library export has no
    // per-conversation status to attach it to, so without this someone asking
    // for PDF gets hundreds of files of question marks and no explanation.
    const original = AISE.formats.markdown.warn;
    AISE.formats.markdown.warn = () => 'Some text uses characters this format cannot draw.';
    try {
      const result = await runLibrary('markdown');
      assert.deepStrictEqual(result.warnings, ['Some text uses characters this format cannot draw.']);
      assert.match(result.message, /cannot draw/, result.message);
    } finally {
      if (original) AISE.formats.markdown.warn = original;
      else delete AISE.formats.markdown.warn;
    }
  });

  await test('says nothing when a format has no warning', async () => {
    const result = await runLibrary('markdown');
    assert.deepStrictEqual(result.warnings, []);
    assert.ok(!/cannot draw/.test(result.message));
  });

  await test('filters by title', async () => {
    const result = await runLibrary('markdown', { titleQuery: 'weekly' });
    assert.strictEqual(result.success, true);
    const files = await readArchive(downloads[0].blob);
    assert.ok(!files['index.md'].includes('Broken One'), 'the filtered-out conversation was never fetched');
  });

  // --- volume splitting -------------------------------------------------
  //
  // Production splits at 256 MB, which no test should generate. The threshold
  // is read through AISE.batch.VOLUME_BYTES precisely so the splitting logic
  // can be exercised at a few kilobytes; the byte count itself is a constant,
  // and what needs proving is everything that happens around a split.

  /** Swap in a library of `count` conversations of roughly `size` bytes each. */
  async function withBigLibrary(count, size, limit, body) {
    const previousApi = AISE.api;
    const previousLimit = AISE.batch.VOLUME_BYTES;
    const library = Array.from({ length: count }, (_, i) => ({
      id: `big${i}`,
      title: `Conversation ${i}`,
      modifiedAt: 1780000000000 + (count - i) * 1000,
    }));

    AISE.batch.VOLUME_BYTES = limit;
    AISE.api = {
      listAllPrompts: async () => library,
      fetchConversation: async (id) => {
        if (id === 'bigFAIL') throw new Error('Prompt unavailable');
        const summary = library.find((c) => c.id === id);
        const c = AISE.model.emptyConversation();
        Object.assign(c, { id, title: summary.title, modifiedAt: summary.modifiedAt });
        c.turns = [
          AISE.model.makeTurn('user', `Question in ${id}`),
          AISE.model.makeTurn('model', `${id} `.repeat(Math.ceil(size / 8))),
        ];
        AISE.model.recomputeStats(c);
        return c;
      },
    };

    try {
      return await body(library);
    } finally {
      AISE.api = previousApi;
      AISE.batch.VOLUME_BYTES = previousLimit;
    }
  }

  await test('splits into numbered volumes once an archive gets large', async () => {
    await withBigLibrary(6, 4000, 6000, async () => {
      const result = await runLibrary('markdown');
      assert.strictEqual(result.success, true);
      assert.ok(downloads.length > 1, `expected several archives, got ${downloads.length}`);

      const total = downloads.length;
      downloads.forEach((download, i) => {
        assert.ok(
          download.filename.endsWith(`(part ${i + 1} of ${total}).zip`),
          `unexpected name: ${download.filename}`
        );
      });
      assert.match(result.message, new RegExp(`${total} archives`), result.message);
      assert.strictEqual(result.files.length, total, 'every archive is named in the result');
    });
  });

  await test('every conversation lands in exactly one volume', async () => {
    // A split that duplicated or dropped a conversation would still produce
    // plausible-looking archives, and nothing else here would notice.
    await withBigLibrary(6, 4000, 6000, async () => {
      await runLibrary('markdown');

      const seen = [];
      for (const download of downloads) {
        const files = await readArchive(download.blob);
        seen.push(...Object.keys(files).filter((f) => f.endsWith('conversation.md')));
      }
      assert.strictEqual(seen.length, 6, `expected 6 conversations across all volumes, got ${seen.length}`);
      assert.strictEqual(new Set(seen).size, 6, 'a conversation appears in two volumes');
    });
  });

  await test('each volume carries its own index and manifest', async () => {
    await withBigLibrary(6, 4000, 6000, async () => {
      await runLibrary('markdown');
      const total = downloads.length;

      for (let i = 0; i < total; i++) {
        const files = await readArchive(downloads[i].blob);
        assert.ok(files['index.md'], `volume ${i + 1} has no index`);

        const manifest = JSON.parse(files['manifest.json']);
        assert.strictEqual(manifest.volume, i + 1, `volume number in archive ${i + 1}`);
        assert.strictEqual(manifest.volumeCount, total, `volume count in archive ${i + 1}`);

        // The index must describe this volume, not the whole run — a link to a
        // folder that is in another archive resolves to nothing.
        const listed = [...files['index.md'].matchAll(/\]\(([^)]+)\)/g)]
          .map((m) => decodeURIComponent(m[1]))
          .filter((target) => target.endsWith('conversation.md'));
        assert.ok(listed.length, `volume ${i + 1} lists nothing`);
        for (const target of listed) {
          assert.ok(files[target], `index of volume ${i + 1} links to ${target}, which is not in it`);
        }
        assert.strictEqual(listed.length, manifest.conversations.length, 'index and manifest disagree');
      }
    });
  });

  await test('failures are reported once, not in every volume', async () => {
    await withBigLibrary(6, 4000, 6000, async (library) => {
      library[3].id = 'bigFAIL';
      const result = await runLibrary('markdown');
      assert.strictEqual(result.failures.length, 1, 'the failure is reported');

      const counts = [];
      for (const download of downloads) {
        counts.push(JSON.parse((await readArchive(download.blob))['manifest.json']).failures.length);
      }
      assert.strictEqual(counts[0], 1, 'volume 1 carries the failure list');
      assert.deepStrictEqual(counts.slice(1), counts.slice(1).map(() => 0), 'later volumes repeat it');
    });
  });

  await test('a library under the threshold stays one unnumbered archive', async () => {
    await withBigLibrary(3, 100, 6000, async () => {
      const result = await runLibrary('markdown');
      assert.strictEqual(downloads.length, 1);
      assert.ok(!/part \d+ of/.test(downloads[0].filename), downloads[0].filename);
      assert.ok(!/archives/.test(result.message), result.message);
      assert.strictEqual(JSON.parse((await readArchive(downloads[0].blob))['manifest.json']).volumeCount, 1);
    });
  });

  await test('concatenated formats are never split', async () => {
    // CSV and JSONL produce one dataset file. Splitting it would leave the
    // second half without a header row and break every consumer.
    await withBigLibrary(6, 4000, 6000, async () => {
      await runLibrary('csv');
      assert.strictEqual(downloads.length, 1, 'one CSV however large');
      assert.ok(downloads[0].filename.endsWith('.csv'));
    });
  });

  await test('says why a run produced nothing rather than downloading an empty archive', async () => {
    // Every match fails to fetch. Handing back a ZIP containing only an index
    // of failures looks like success to anyone glancing at their downloads.
    await assert.rejects(
      () => runLibrary('markdown', { titleQuery: 'broken' }),
      /None of the 1 conversations could be exported/
    );
    assert.strictEqual(downloads.length, 0);
  });

  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`FAIL  ${name}\n      ${error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
