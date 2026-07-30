/**
 * End-to-end export tests, against a real Chrome running the real extension.
 *
 * The trick that makes this possible without a Google account: Playwright
 * fulfils requests to `https://aistudio.google.com/**` itself, so the page has
 * that real origin — which is what decides whether Chrome injects the content
 * scripts — while the body is ours. Google's own endpoints are intercepted the
 * same way and answered with canned wire-format payloads, so a full export runs
 * start to finish, offline and deterministic, and the downloaded file is read
 * back off disk and checked.
 *
 * This is the only test that covers content-script injection, the MAIN-world
 * transport, the popup-to-content message path, the overlay, and the download
 * itself. Everything upstream of that is faked in the Node suites.
 *
 *     npm run test:ui:export
 *
 * Headed only, one launch per process — see the note in test/ui.js.
 *
 * @license MIT
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  console.log('playwright not installed - run `npm install`. Skipping export UI tests.');
  process.exit(0);
}

const PROMPT_ID = 'TESTPROMPT0000000000000000000001';
const IMAGE_ID = 'TESTIMAGE00000000000000000000001';
const DOC_ID = 'TESTDOC0000000000000000000000001';

// A 1x1 PNG, so the bytes that come out of the archive are a real image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n% fake fixture\n', 'utf8');

// --- wire-format fixtures ------------------------------------------------

/** The positional-array shape ResolveDriveResource returns. */
function wirePrompt() {
  const turn = (over) => {
    const t = new Array(36).fill(null);
    t[8] = 'user';
    return Object.assign(t, over);
  };
  const part = (text, thought) => {
    const p = new Array(15).fill(null);
    p[1] = text;
    if (thought) p[12] = 1;
    return p;
  };

  const runSettings = new Array(35).fill(null);
  runSettings[0] = 0.7;
  runSettings[2] = 'models/gemini-3-pro';
  runSettings[4] = 0.95;

  const metadata = new Array(12).fill(null);
  metadata[0] = 'Playwright Fixture Chat';
  metadata[4] = [[1784534516, 0], null];

  const prompt = new Array(14).fill(null);
  prompt[0] = `prompts/${PROMPT_ID}`;
  prompt[3] = runSettings;
  prompt[4] = metadata;
  prompt[13] = [
    [
      turn({ 3: [IMAGE_ID], 18: 250 }),
      turn({ 3: [DOC_ID], 18: 400 }),
      turn({ 0: 'What is in these files?', 18: 8 }),
      turn({ 0: 'Thinking about it.', 8: 'model', 18: 12, 29: [part('Thinking about it.', true)] }),
      turn({ 0: 'A picture and a document.', 8: 'model', 16: 1, 18: 9, 29: [part('A picture and a document.', false)] }),
    ],
    [],
  ];
  return [prompt];
}

const DRIVE_FILES = {
  [IMAGE_ID]: { name: 'diagram.png', mimeType: 'image/png', bytes: PNG },
  [DOC_ID]: { name: 'notes.pdf', mimeType: 'application/pdf', bytes: PDF },
};

// --- harness -------------------------------------------------------------

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
  }
}

/** Everything Google would have served, served by us instead. */
async function installRoutes(context, seen) {
  await context.route('https://aistudio.google.com/**', (route) => {
    if (route.request().resourceType() !== 'document') return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      // The page body is irrelevant to the API path; it only has to exist so
      // the content scripts have a document with the right origin to attach to.
      body: '<!doctype html><html><head><title>AI Studio</title></head><body></body></html>',
    });
  });

  await context.route('https://alkalimakersuite-pa.clients6.google.com/**', async (route) => {
    const method = route.request().url().split('/').pop();
    seen.rpc.push(method);

    if (method === 'ResolveDriveResource') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wirePrompt()) });
    }
    if (method === 'GenerateAccessToken') {
      // [token, expirySeconds] is the shape the transport reads.
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['fake-token', 3600]) });
    }
    if (method === 'ListPrompts') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([[], null]) });
    }
    return route.fulfill({ status: 404, body: '[]' });
  });

  await context.route('https://content.googleapis.com/drive/v3/files/**', (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').filter(Boolean).pop();
    const file = DRIVE_FILES[id];
    if (!file) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });

    if (url.searchParams.get('alt') === 'media') {
      seen.downloads.push(id);
      return route.fulfill({ status: 200, contentType: file.mimeType, body: file.bytes });
    }
    seen.metadata.push(id);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id, name: file.name, mimeType: file.mimeType, size: String(file.bytes.length) }),
    });
  });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-export-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-dl-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;

    const seen = { rpc: [], metadata: [], downloads: [] };
    await installRoutes(context, seen);

    // The transport derives a SAPISIDHASH from this and refuses to run without
    // it, which is the correct behaviour when nobody is signed in.
    await context.addCookies([
      { name: 'SAPISID', value: 'fake-sapisid-value', domain: '.google.com', path: '/', secure: true },
    ]);

    console.log(`\nrunning against ${extensionId}\n`);

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`https://aistudio.google.com/prompts/${PROMPT_ID}`);

    /** Ask the content script to export, and capture what lands on disk. */
    async function exportAs(formatId) {
      const before = seen.downloads.length;
      const [download, result] = await Promise.all([
        context.waitForEvent('download', { timeout: 60000 }),
        worker.evaluate(
          async ([id, format]) => {
            const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
            return chrome.tabs.sendMessage(tab.id, { action: 'export', formatId: format });
          },
          [extensionId, formatId]
        ),
      ]);

      const target = path.join(downloadDir, `${formatId}-${download.suggestedFilename()}`);
      await download.saveAs(target);
      return { result, file: target, name: download.suggestedFilename(), freshDownloads: seen.downloads.length - before };
    }

    // --- injection ------------------------------------------------------

    await test('content scripts inject on an AI Studio page', async () => {
      const marker = await page.evaluate(() => document.documentElement.dataset.aiStudioExporter || null);
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
      assert.strictEqual(marker, manifest.version);
    });

    await test('no content script throws on load', async () => {
      assert.deepStrictEqual(pageErrors, []);
    });

    await test('the content script reports its status to the extension', async () => {
      const status = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
        return chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      });
      assert.deepStrictEqual(status, { isExporting: false });
    });

    // --- a real export --------------------------------------------------

    let markdown;

    await test('exports a conversation through the API path', async () => {
      markdown = await exportAs('markdown');
      assert.strictEqual(markdown.result.success, true, markdown.result.message);
      assert.ok(seen.rpc.includes('ResolveDriveResource'), 'the API was actually used');
    });

    await test('the archive is named after the conversation', async () => {
      assert.ok(markdown.name.startsWith('Playwright Fixture Chat'), markdown.name);
      assert.ok(markdown.name.endsWith('.zip'), 'attachments mean a ZIP');
    });

    await test('the export contains the conversation and both attachments', async () => {
      // Read the archive back with the same JSZip the extension used.
      const JSZip = (0, eval)(fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip');
      const zip = await JSZip.loadAsync(fs.readFileSync(markdown.file));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

      assert.ok(names.includes('conversation.md'), names.join(', '));
      assert.ok(names.includes('attachments/diagram.png'), names.join(', '));
      assert.ok(names.includes('attachments/notes.pdf'), names.join(', '));

      const png = await zip.files['attachments/diagram.png'].async('nodebuffer');
      assert.ok(png.equals(PNG), 'the image survived the round trip byte for byte');

      const md = await zip.files['conversation.md'].async('string');
      assert.ok(md.includes('# Playwright Fixture Chat'));
      assert.ok(md.includes('A picture and a document.'), 'the answer is present');
      assert.ok(md.includes('## 🧠 Model (Reasoning)'), 'and reasoning is its own message');
      assert.ok(md.includes('![diagram.png](attachments/diagram.png)'), 'the image is linked');
    });

    await test('attachments were folded into the message they were sent with', async () => {
      const JSZip = (0, eval)(fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip');
      const zip = await JSZip.loadAsync(fs.readFileSync(markdown.file));
      const md = await zip.files['conversation.md'].async('string');

      const userBlocks = md.split('<!-- aise:turn role=user -->').length - 1;
      assert.strictEqual(userBlocks, 1, 'three AI Studio turns became one message');
      // 250 + 400 + 8, summed as the turns merged.
      assert.ok(md.includes('658 tokens'), 'and their token counts were added up');
    });

    await test('re-exporting in another format reuses the cached attachments', async () => {
      const json = await exportAs('json');
      assert.strictEqual(json.result.success, true, json.result.message);
      assert.strictEqual(json.freshDownloads, 0, 'no attachment was fetched a second time');
    });

    await test('a Pro format is downgraded to Markdown without a licence', async () => {
      const pdf = await exportAs('pdf');
      assert.strictEqual(pdf.result.success, true, pdf.result.message);
      assert.match(pdf.result.message, /Pro format/, pdf.result.message);
      assert.ok(pdf.name.endsWith('.zip'));
    });

    await test('library export is refused without a licence', async () => {
      const result = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
        return chrome.tabs.sendMessage(tab.id, { action: 'exportLibrary', formatId: 'markdown' });
      });
      assert.strictEqual(result.success, false);
      assert.match(result.message, /Pro licence/);
    });

    await test('an unknown action is rejected', async () => {
      const result = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
        return chrome.tabs.sendMessage(tab.id, { action: 'wipeEverything' });
      });
      assert.strictEqual(result.success, false);
      assert.match(result.message, /Unsupported action/);
    });

    await test('excluding a file type skips its download entirely', async () => {
      await worker.evaluate(
        () => new Promise((r) => chrome.storage.sync.set({ scrapeAttachments: false }, r))
      );
      // A different conversation id would be cached; clear it by reloading the
      // page, which drops the content script's in-memory cache with it.
      await page.reload();
      await page.waitForFunction(() => !!document.documentElement.dataset.aiStudioExporter);

      const before = seen.downloads.length;
      const run = await exportAs('markdown');
      assert.strictEqual(run.result.success, true, run.result.message);

      const fetched = seen.downloads.slice(before);
      assert.deepStrictEqual(fetched, [IMAGE_ID], 'only the image was transferred');

      const JSZip = (0, eval)(fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip');
      const zip = await JSZip.loadAsync(fs.readFileSync(run.file));
      const md = await zip.files['conversation.md'].async('string');
      assert.ok(md.includes('1 attachment not included in export'), 'and the export says so');
    });
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error('');
    for (const { name, error } of failures) {
      console.error(`FAIL  ${name}\n      ${error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
