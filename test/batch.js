/**
 * Integration test for whole-library export.
 *
 * Separate from test/run.js because it drives the real pipeline end to end:
 * JSZip, async rendering, archive generation. Rather than the pure helpers.
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

  /**
   * Swap in a library of `count` conversations of roughly `size` bytes each.
   * `sizeFor` overrides the size of individual conversations by index, which is
   * how the one-conversation-larger-than-a-whole-volume case is set up.
   */
  async function withBigLibrary(count, size, limit, body, sizeFor = () => null) {
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
        const index = library.findIndex((c) => c.id === id);
        const summary = library[index];
        const bytes = sizeFor(index) || size;
        const c = AISE.model.emptyConversation();
        Object.assign(c, { id, title: summary.title, modifiedAt: summary.modifiedAt });
        c.turns = [
          AISE.model.makeTurn('user', `Question in ${id}`),
          AISE.model.makeTurn('model', 'x'.repeat(bytes)),
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

  /** The rendered size of each conversation in a volume, largest first. */
  async function volumeSizes(blob) {
    const files = await readArchive(blob);
    return Object.keys(files)
      .filter((f) => f.endsWith('conversation.md'))
      .map((f) => files[f].length)
      .sort((a, b) => b - a);
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

  await test('every volume accounts for the whole library, not just its own share', async () => {
    // Splitting the index along with the files left each archive unable to say
    // where anything else went, so a conversation could be in your downloads
    // folder with nothing anywhere pointing at it.
    await withBigLibrary(6, 4000, 6000, async () => {
      await runLibrary('markdown');
      const total = downloads.length;
      assert.ok(total > 1, 'the library did not split, so there is nothing to check');

      for (let i = 0; i < total; i++) {
        const files = await readArchive(downloads[i].blob);
        const index = files['index.md'];
        assert.ok(index, `volume ${i + 1} has no index`);

        const manifest = JSON.parse(files['manifest.json']);
        assert.strictEqual(manifest.volume, i + 1, `volume number in archive ${i + 1}`);
        assert.strictEqual(manifest.volumeCount, total, `volume count in archive ${i + 1}`);
        assert.strictEqual(manifest.library.length, 6, `volume ${i + 1} manifest omits part of the library`);
        for (const entry of manifest.library) {
          assert.ok(entry.volume >= 1 && entry.volume <= total, `entry has no usable volume: ${entry.title}`);
        }

        // Every conversation is named, wherever it lives.
        for (let n = 0; n < 6; n++) {
          assert.ok(index.includes(`Conversation ${n}`), `volume ${i + 1} index omits Conversation ${n}`);
        }
        assert.match(index, new RegExp(`part ${i + 1} of ${total}`), `volume ${i + 1} does not say which part it is`);

        // Links, though, only ever point at files in this same archive.
        const linked = [...index.matchAll(/\]\(([^)]+)\)/g)]
          .map((m) => decodeURIComponent(m[1]))
          .filter((target) => target.endsWith('conversation.md'));
        assert.ok(linked.length, `volume ${i + 1} links to nothing`);
        for (const target of linked) {
          assert.ok(files[target], `index of volume ${i + 1} links to ${target}, which is not in it`);
        }
        assert.strictEqual(linked.length, manifest.conversations.length, 'index and manifest disagree');

        // And the rest are pointed at the part that does hold them.
        const elsewhere = manifest.library.filter((e) => e.volume !== i + 1);
        for (const entry of elsewhere) {
          assert.match(
            index,
            new RegExp(`${entry.title}:[^\\n]*in part ${entry.volume}`),
            `volume ${i + 1} does not say where ${entry.title} is`
          );
        }
      }
    });
  });

  await test('a single-volume export still describes the whole library', async () => {
    await withBigLibrary(3, 100, 100000, async () => {
      await runLibrary('markdown');
      const files = await readArchive(downloads[0].blob);
      const manifest = JSON.parse(files['manifest.json']);

      assert.strictEqual(manifest.library.length, 3, 'library list is missing');
      assert.deepStrictEqual(manifest.library.map((e) => e.volume), [1, 1, 1]);
      // Nothing about being split, because it was not.
      assert.ok(!/in part \d/.test(files['index.md']), files['index.md']);
      assert.ok(!/This archive/.test(files['index.md']), files['index.md']);
    });
  });

  await test('no volume exceeds the limit unless one conversation does', async () => {
    // The size check used to run *after* a conversation was added, and three
    // are fetched concurrently, so a volume could overshoot by three whole
    // conversations. For anyone whose conversations are individually huge
    // (which is most of the reason volumes exist), that defeated the limit.
    await withBigLibrary(9, 4000, 10000, async () => {
      await runLibrary('markdown');
      assert.ok(downloads.length > 1, 'the library did not split at all');

      for (let i = 0; i < downloads.length; i++) {
        const sizes = await volumeSizes(downloads[i].blob);
        const total = sizes.reduce((a, b) => a + b, 0);
        assert.ok(
          sizes.length === 1 || total <= 10000,
          `volume ${i + 1} holds ${sizes.length} conversations totalling ${total} bytes`
        );
      }
    });
  });

  await test('a conversation larger than a whole volume gets one to itself', async () => {
    // It cannot be split any further, so the limit has to give; but it must
    // not drag its neighbours over with it.
    await withBigLibrary(
      4, 2000, 10000,
      async () => {
        await runLibrary('markdown');
        const sizes = await Promise.all(downloads.map((d) => volumeSizes(d.blob)));
        const huge = sizes.find((volume) => volume[0] > 10000);
        assert.ok(huge, `no volume holds the large conversation: ${JSON.stringify(sizes)}`);
        assert.strictEqual(huge.length, 1, 'the large conversation shares a volume');
      },
      (index) => (index === 1 ? 40000 : null)
    );
  });

  await test('failures are reported in every volume', async () => {
    // A failure list that exists in one archive out of three is a failure list
    // most people never see.
    await withBigLibrary(6, 4000, 6000, async (library) => {
      library[3].id = 'bigFAIL';
      const result = await runLibrary('markdown');
      assert.strictEqual(result.failures.length, 1, 'the failure is reported');

      for (let i = 0; i < downloads.length; i++) {
        const files = await readArchive(downloads[i].blob);
        const manifest = JSON.parse(files['manifest.json']);
        assert.strictEqual(manifest.failures.length, 1, `volume ${i + 1} manifest omits the failure`);
        assert.ok(files['index.md'].includes('Not exported'), `volume ${i + 1} index omits the failure`);
      }
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
