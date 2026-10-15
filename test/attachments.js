/**
 * Attachment resolution tests.
 *
 * Drive is faked at the API boundary and every request is counted, because the
 * things worth asserting here are all about requests that should not happen:
 * bytes fetched for a file type the user excluded, and bytes fetched twice for
 * the same conversation exported in two formats.
 *
 * @license MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

const load = (...rels) => {
  for (const rel of rels) (0, eval)(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
};

load('src/model.js', 'src/api/attachments.js');
const { AISE } = globalThis;

// --- fake Drive ---------------------------------------------------------

const FILES = {
  img1: { name: 'diagram.png', mimeType: 'image/png', size: 1000 },
  img2: { name: 'chart.jpg', mimeType: 'image/jpeg', size: 2000 },
  doc1: { name: 'notes.pdf', mimeType: 'application/pdf', size: 3000 },
  gone: null,
};

let metadataCalls = [];
let downloadCalls = [];

AISE.api = {
  fetchAttachmentMetadata: async (id) => {
    metadataCalls.push(id);
    if (!FILES[id]) throw new Error(`Drive metadata failed (404) for ${id}`);
    return Object.assign({ id }, FILES[id]);
  },
  downloadAttachment: async (id) => {
    downloadCalls.push(id);
    if (!FILES[id]) throw new Error(`Drive download failed (404) for ${id}`);
    return {
      meta: Object.assign({ id }, FILES[id]),
      buffer: new ArrayBuffer(FILES[id].size),
      effectiveMimeType: FILES[id].mimeType,
      exportedExtension: null,
    };
  },
};

function conversationWith(ids) {
  const c = AISE.model.emptyConversation('ABC', 'api');
  c.turns = ids.map((id) =>
    AISE.model.makeTurn('user', '', { parts: [{ type: 'file', driveId: id }] })
  );
  return c;
}

const ALL_ON = {
  scrapeImages: true,
  scrapeAttachments: true,
  scrapeReasoning: true,
  condenseAttachments: true,
};

let passed = 0;
const failures = [];

async function test(name, fn) {
  metadataCalls = [];
  downloadCalls = [];
  AISE.attachments.clearCache();
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push({ name, error });
  }
}

// --- tests --------------------------------------------------------------

async function main() {
  await test('downloads every attachment when both types are wanted', async () => {
    const c = conversationWith(['img1', 'doc1']);
    const result = await AISE.attachments.resolveAttachments(c, null, null, { settings: ALL_ON });

    assert.deepStrictEqual(downloadCalls.sort(), ['doc1', 'img1']);
    assert.strictEqual(result.resolved, 2);
    assert.strictEqual(result.skipped, 0);
  });

  await test('does not download file types the user excluded', async () => {
    // The bug this covers: type is only known from metadata, so filtering used
    // to happen after every byte had already been transferred.
    const c = conversationWith(['img1', 'img2', 'doc1']);
    const result = await AISE.attachments.resolveAttachments(c, null, null, {
      settings: Object.assign({}, ALL_ON, { scrapeAttachments: false }),
    });

    assert.deepStrictEqual(downloadCalls.sort(), ['img1', 'img2'], 'the PDF was never fetched');
    assert.strictEqual(metadataCalls.length, 3, 'but all three were classified');
    assert.strictEqual(result.skipped, 1);
  });

  await test('classifies excluded attachments so they can still be counted', async () => {
    const c = conversationWith(['doc1']);
    await AISE.attachments.resolveAttachments(c, null, null, {
      settings: Object.assign({}, ALL_ON, { scrapeAttachments: false }),
    });

    const part = c.turns[0].parts[0];
    assert.strictEqual(part.type, 'file');
    assert.strictEqual(part.name, 'notes.pdf', 'named even though it was never downloaded');
    assert.ok(!part.buffer, 'and no bytes were kept');
  });

  await test('re-exporting the same conversation reuses cached bytes', async () => {
    // Someone exporting a conversation as Markdown and then as PDF should not
    // pay for the attachments twice.
    const first = conversationWith(['img1', 'doc1']);
    await AISE.attachments.resolveAttachments(first, null, null, { settings: ALL_ON });
    assert.strictEqual(downloadCalls.length, 2);

    const second = conversationWith(['img1', 'doc1']);
    await AISE.attachments.resolveAttachments(second, null, null, { settings: ALL_ON });

    assert.strictEqual(downloadCalls.length, 2, 'no second round of downloads');
    assert.strictEqual(second.turns[0].parts[0].buffer.byteLength, 1000, 'bytes came back anyway');
    assert.strictEqual(second.turns[1].parts[0].name, 'notes.pdf');
  });

  await test('a cache miss after eviction still produces the file', async () => {
    const c = conversationWith(['img1']);
    await AISE.attachments.resolveAttachments(c, null, null, { settings: ALL_ON });
    AISE.attachments.clearCache();

    const again = conversationWith(['img1']);
    await AISE.attachments.resolveAttachments(again, null, null, { settings: ALL_ON });
    assert.strictEqual(downloadCalls.length, 2, 'refetched, as it must be');
    assert.strictEqual(again.turns[0].parts[0].buffer.byteLength, 1000);
  });

  await test('caching can be turned off for library exports', async () => {
    const c = conversationWith(['img1']);
    await AISE.attachments.resolveAttachments(c, null, null, { settings: ALL_ON, cache: false });

    const again = conversationWith(['img1']);
    await AISE.attachments.resolveAttachments(again, null, null, { settings: ALL_ON, cache: false });
    assert.strictEqual(downloadCalls.length, 2, 'nothing was retained between runs');
  });

  await test('a missing file costs only that attachment', async () => {
    const c = conversationWith(['img1', 'gone', 'doc1']);
    const result = await AISE.attachments.resolveAttachments(c, null, null, { settings: ALL_ON });

    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.resolved, 2, 'the other two still came through');

    const failedPart = c.turns[1].parts[0];
    assert.ok(failedPart.error, 'and the failure is recorded on the part');
    assert.ok(failedPart.name.startsWith('attachment-'), 'with a placeholder name');
  });

  await test('cancelling stops further downloads', async () => {
    const c = conversationWith(['img1', 'img2', 'doc1']);
    await AISE.attachments.resolveAttachments(c, null, () => true, { settings: ALL_ON });
    assert.strictEqual(downloadCalls.length, 0);
  });

  await test('progress is reported against downloads, not references', async () => {
    // Reporting "1/3" while only one file will ever be fetched is a progress
    // bar that never finishes.
    const seen = [];
    const c = conversationWith(['img1', 'img2', 'doc1']);
    await AISE.attachments.resolveAttachments(c, (done, total) => seen.push(`${done}/${total}`), null, {
      settings: Object.assign({}, ALL_ON, { scrapeImages: false }),
    });
    assert.deepStrictEqual(seen, ['1/1']);
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
