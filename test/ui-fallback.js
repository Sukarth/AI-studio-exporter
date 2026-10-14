/**
 * The page-scraping fallback, end to end, against a real Chrome running the
 * real extension.
 *
 * test/ui-export.js covers the API path. This covers what happens when that
 * path fails: every call to AI Studio's API is answered with a 500, so the
 * export has to fall back to reading the rendered page, and the page is a
 * fixture laid out the way the scraper in content.js expects AI Studio's to be
 * (chat turns, the raw-output toggle behind "View more actions", an image, a
 * file chip and a collapsed reasoning panel).
 *
 * It exists to answer one question with evidence: does the fallback still work
 * with the permissions the store package actually has? It needs none of
 * activeTab, scripting or downloads, and this proves it, because it runs
 * against whatever AISE_EXTENSION_DIR points at, including an unpacked store
 * ZIP.
 *
 * What it cannot prove is that AI Studio's live page still matches these
 * selectors. That is a property of Google's markup, not of this code.
 *
 *     npm run test:ui:fallback
 *
 * Headed only, one launch per process; see the note in test/ui.js.
 *
 * @license MIT
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
// The extension under test: the source tree, or an unpacked store package.
const EXTENSION = process.env.AISE_EXTENSION_DIR || ROOT;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  console.log('playwright not installed - run `npm install`. Skipping fallback UI tests.');
  process.exit(0);
}

const PROMPT_ID = 'TESTPROMPT0000000000000000000002';

// A 1x1 PNG, inlined so the page "has loaded" it the way AI Studio's would.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A page shaped like AI Studio's, as far as the scraper looks. The raw-output
 * toggle lives in a menu that only exists once "View more actions" is clicked,
 * and its label says which way it will switch, which is how the scraper reads
 * the current mode. The reasoning text sits in a collapsed panel under a
 * chevron, as the real one does.
 */
const FIXTURE_PAGE = `<!doctype html>
<html><head><title>AI Studio</title></head>
<body>
  <div class="actions pointer mode-title">Fallback Fixture Chat</div>
  <button aria-label="View more actions" id="more">more_vert</button>
  <div id="menu"></div>

  <ms-chat-turn>
    <div data-turn-role="User">
      <ms-text-chunk>Here is a diagram and my notes.</ms-text-chunk>
      <img class="loaded-image" alt="diagram.png" src="data:image/png;base64,${PNG_B64}">
      <ms-file-chunk>
        <div class="file-chunk-container"><span>notes.pdf</span><span>12 KB</span></div>
      </ms-file-chunk>
    </div>
  </ms-chat-turn>

  <ms-chat-turn>
    <div data-turn-role="Model">
      <div class="thoughts"><span>chevron_right</span> Thoughts
        <div class="mat-expansion-panel-body"><ms-text-chunk>Reasoning from the page.</ms-text-chunk></div>
      </div>
      <ms-text-chunk>The answer from the page.</ms-text-chunk>
    </div>
  </ms-chat-turn>

  <script>
    let raw = false;
    document.getElementById('more').addEventListener('click', () => {
      const menu = document.getElementById('menu');
      if (menu.firstChild) { menu.textContent = ''; return; }
      const toggle = document.createElement('button');
      toggle.setAttribute('aria-label', 'Toggle viewing raw output');
      toggle.textContent = raw ? 'Show markdown formatting' : 'View raw output';
      toggle.addEventListener('click', () => {
        raw = !raw;
        toggle.textContent = raw ? 'Show markdown formatting' : 'View raw output';
        window.__rawToggles = (window.__rawToggles || 0) + 1;
      });
      menu.appendChild(toggle);
    });
  </script>
</body></html>`;

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

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-fallback-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-fallback-dl-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;

    const seen = { rpc: 0, drive: 0 };

    await context.route('https://aistudio.google.com/**', (route) => {
      if (route.request().resourceType() !== 'document') return route.abort();
      return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_PAGE });
    });
    // The API is down. Every call fails, which is the condition the fallback
    // exists for.
    await context.route('https://alkalimakersuite-pa.clients6.google.com/**', (route) => {
      seen.rpc++;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '[]' });
    });
    await context.route('https://content.googleapis.com/**', (route) => {
      seen.drive++;
      return route.fulfill({ status: 500, body: '' });
    });
    // Signed in, as far as the transport can tell, so it really does try the
    // API before giving up on it.
    await context.addCookies([
      { name: 'SAPISID', value: 'fake-sapisid-value', domain: '.google.com', path: '/', secure: true },
    ]);

    // The scraper waits loadDelay between steps; the fixture renders at once.
    await worker.evaluate(() => chrome.storage.sync.set({ loadDelay: 100 }));

    console.log(`\nrunning against ${extensionId}\n`);

    const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));

    await test('runs with only the permissions the store package declares', async () => {
      assert.deepStrictEqual([...manifest.permissions].sort(), ['alarms', 'storage']);
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`https://aistudio.google.com/prompts/${PROMPT_ID}`);

    await test('content scripts inject on the fixture page', async () => {
      const marker = await page.evaluate(() => document.documentElement.dataset.aiStudioExporter || null);
      assert.strictEqual(marker, manifest.version);
    });

    let run;
    await test('an export falls back to the page when the API fails, and downloads', async () => {
      const [download, result] = await Promise.all([
        context.waitForEvent('download', { timeout: 60000 }),
        worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
          return chrome.tabs.sendMessage(tab.id, { action: 'export', formatId: 'markdown' });
        }),
      ]);
      const file = path.join(downloadDir, download.suggestedFilename());
      await download.saveAs(file);
      run = { result, file, name: download.suggestedFilename() };

      assert.strictEqual(result.success, true, result.message);
      assert.ok(seen.rpc > 0, 'the API was tried first');
    });

    await test('the fallback switched raw output on and back off', async () => {
      assert.strictEqual(await page.evaluate(() => window.__rawToggles || 0), 2);
    });

    await test('the export holds what the page showed', async () => {
      assert.ok(run, 'no export to read');
      assert.ok(run.name.startsWith('Fallback Fixture Chat'), run.name);

      const JSZip = (0, eval)(fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip');
      const zip = await JSZip.loadAsync(fs.readFileSync(run.file));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      const md = await zip.files['conversation.md'].async('string');

      assert.ok(md.includes('Here is a diagram and my notes.'), 'the user message');
      assert.ok(md.includes('Reasoning from the page.'), 'the reasoning');
      assert.ok(md.includes('The answer from the page.'), 'the answer');
      assert.ok(md.includes('notes.pdf'), 'the attachment chip is named');

      const image = names.find((n) => /diagram\.png$/.test(n));
      assert.ok(image, `the page's image is in the archive: ${names.join(', ')}`);
      const bytes = await zip.files[image].async('nodebuffer');
      assert.ok(bytes.equals(Buffer.from(PNG_B64, 'base64')), 'with the bytes the page had');
    });

    await test('the toolbar badge reports a page-read export, not a full one', async () => {
      const deadline = Date.now() + 5000;
      let text = null;
      while (Date.now() < deadline) {
        text = await worker.evaluate(() => chrome.action.getBadgeText({}));
        if (text) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const source = fs.readFileSync(path.join(ROOT, 'src', 'badge.js'), 'utf8');
      const partial = /\bpartial: \{[\s\S]*?text: '([^']*)'/.exec(source);
      assert.ok(partial, 'badge.js declares a partial state');
      assert.strictEqual(text, partial[1]);
    });

    await test('no content script threw', async () => {
      assert.deepStrictEqual(pageErrors, []);
    });
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const { name, error } of failures) {
    console.log(`\n${name}\n  ${(error && error.stack) || error}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
