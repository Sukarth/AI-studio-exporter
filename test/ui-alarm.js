/**
 * Scheduled backup, against a real Chrome running the real extension.
 *
 * Everything else about backups can be tested by calling `runBackup()`
 * directly, which proves nothing about the part that actually breaks: whether
 * Chrome's own alarm scheduler ever fires, and whether the service worker is
 * still around to hear it. So this test registers a real `chrome.alarms` alarm,
 * waits for Chrome to fire it, and checks that a backup archive lands on disk
 * as a result. Nothing calls `runBackup()`.
 *
 * The alarm is re-created with a one-second delay purely so the test finishes:
 * Chrome honours sub-minute delays for unpacked extensions and clamps to one
 * minute otherwise, and the timeout here accommodates either. The scheduling
 * contract — that enabling a daily backup arms a 1440-minute alarm — is
 * asserted separately, against the alarm `configure()` actually creates.
 *
 * One boundary worth knowing: Playwright can only fulfil requests for pages it
 * opened itself, so a tab the *extension* opens reaches the real Google and is
 * bounced to a sign-in page. That splits the run in two. The tab-acquisition
 * tests use that path deliberately — it is also, exactly, the signed-out case
 * — and assert what the backup does to the user's browser. The export tests
 * then work against a page Playwright opened, so the export itself is real.
 *
 *     npm run test:ui:alarm
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
  console.log('playwright not installed - run `npm install`. Skipping alarm tests.');
  process.exit(0);
}

const ALARM_NAME = 'aise:scheduled-backup';
const LIBRARY = [
  { id: 'ALARMPROMPT000000000000000000001', title: 'First Backed Up Chat', modified: 1784534516 },
  { id: 'ALARMPROMPT000000000000000000002', title: 'Second Backed Up Chat', modified: 1784534600 },
];

// --- wire-format fixtures ------------------------------------------------

/** One entry of a ListPrompts page. */
function wireSummary({ id, title, modified }) {
  const metadata = new Array(12).fill(null);
  metadata[0] = title;
  metadata[4] = [[modified, 0], null];

  const prompt = new Array(14).fill(null);
  prompt[0] = `prompts/${id}`;
  prompt[4] = metadata;
  return prompt;
}

/** What ResolveDriveResource returns for one of them. */
function wirePrompt(id, title) {
  const turn = (over) => {
    const t = new Array(36).fill(null);
    t[8] = 'user';
    return Object.assign(t, over);
  };
  const part = (text) => {
    const p = new Array(15).fill(null);
    p[1] = text;
    return p;
  };

  const metadata = new Array(12).fill(null);
  metadata[0] = title;
  metadata[4] = [[1784534516, 0], null];

  const prompt = new Array(14).fill(null);
  prompt[0] = `prompts/${id}`;
  prompt[4] = metadata;
  prompt[13] = [
    [
      turn({ 0: `Question in ${title}`, 18: 8 }),
      turn({ 0: `Answer in ${title}`, 8: 'model', 16: 1, 18: 9, 29: [part(`Answer in ${title}`)] }),
    ],
    [],
  ];
  return [prompt];
}

// --- harness -------------------------------------------------------------

let passed = 0;
const failures = [];

// Module scope so expectDownload() can reach it.
let context;

/**
 * A download the test is about to trigger.
 *
 * The rejection is swallowed here so that a test failing before it awaits
 * the download does not take the whole process down with an unhandled
 * rejection, hiding the failure that actually mattered.
 */
function expectDownload() {
  const promise = context.waitForEvent('download', { timeout: 120000 });
  promise.catch(() => {});
  return promise;
}

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

async function installRoutes(context, seen) {
  await context.route('https://aistudio.google.com/**', (route) => {
    if (route.request().resourceType() !== 'document') return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>AI Studio</title></head><body></body></html>',
    });
  });

  await context.route('https://alkalimakersuite-pa.clients6.google.com/**', async (route) => {
    const method = route.request().url().split('/').pop();
    seen.rpc.push(method);

    if (method === 'ListPrompts') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([LIBRARY.map(wireSummary), null]),
      });
    }
    if (method === 'ResolveDriveResource') {
      const body = JSON.parse(route.request().postData() || '[]');
      const id = Array.isArray(body) ? body[0] : null;
      const summary = LIBRARY.find((c) => c.id === id) || LIBRARY[0];
      seen.fetched.push(summary.id);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(wirePrompt(summary.id, summary.title)),
      });
    }
    if (method === 'GenerateAccessToken') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['fake-token', 3600]) });
    }
    return route.fulfill({ status: 404, body: '[]' });
  });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-alarm-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-alarm-dl-'));

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });

    const seen = { rpc: [], fetched: [] };
    await installRoutes(context, seen);
    await context.addCookies([
      { name: 'SAPISID', value: 'fake-sapisid-value', domain: '.google.com', path: '/', secure: true },
    ]);

    console.log(`\nrunning against ${new URL(worker.url()).host}\n`);

    /**
     * Wait for the content script to finish.
     *
     * A download event fires when the file starts arriving, which is before
     * the export function returns — so starting the next backup right after it
     * is rejected with "an export is already running". Real users cannot hit
     * this; two tests in a row can.
     */
    async function waitForIdle() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
          if (!tab) return { isExporting: false };
          try {
            return await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
          } catch (_) {
            return { isExporting: false };
          }
        });
        if (status && !status.isExporting) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('the content script never went idle');
    }

    // Deliberately *not* an AI Studio tab. A backup scheduled for the middle
    // of the night finds whatever the user left open, which is almost never
    // AI Studio, so opening its own tab is the normal path and the one worth
    // testing. This page stands in for the user's actual work.
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Something else</title>Not AI Studio');

    // Library export is Pro. Written straight to storage in the shape
    // license.js writes, so this test does not also depend on Polar.
    await worker.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.storage.local.set(
            {
              proLicense: {
                key: 'AISEPAK-TEST-0000-0000',
                activationId: 'activation_alarm_test',
                activatedAt: Date.now(),
                lastCheckedAt: Date.now(),
                valid: true,
              },
            },
            resolve
          )
        )
    );

    // --- the scheduling contract ----------------------------------------

    await test('enabling a daily backup arms a daily alarm', async () => {
      const alarm = await worker.evaluate(async () => {
        await globalThis.AISE.schedule.configure({ enabled: true, frequency: 'daily', formatId: 'markdown' });
        return chrome.alarms.get('aise:scheduled-backup');
      });

      assert.ok(alarm, 'no alarm was created');
      assert.strictEqual(alarm.periodInMinutes, 24 * 60, 'daily is 1440 minutes');
      // Not immediate: enabling a backup on the settings page should not start
      // one while the user is still looking at it.
      const minutesAway = (alarm.scheduledTime - Date.now()) / 60000;
      assert.ok(minutesAway > 1 && minutesAway <= 6, `first run is ${minutesAway.toFixed(1)} minutes away`);
    });

    await test('changing the frequency re-arms at the new period', async () => {
      const weekly = await worker.evaluate(async () => {
        await globalThis.AISE.schedule.configure({ frequency: 'weekly' });
        return chrome.alarms.get('aise:scheduled-backup');
      });
      assert.strictEqual(weekly.periodInMinutes, 7 * 24 * 60);

      const monthly = await worker.evaluate(async () => {
        await globalThis.AISE.schedule.configure({ frequency: 'monthly' });
        return chrome.alarms.get('aise:scheduled-backup');
      });
      assert.strictEqual(monthly.periodInMinutes, 30 * 24 * 60);
    });

    await test('disabling the backup clears the alarm entirely', async () => {
      const alarm = await worker.evaluate(async () => {
        await globalThis.AISE.schedule.configure({ enabled: false });
        return chrome.alarms.get('aise:scheduled-backup');
      });
      assert.ok(!alarm, 'a disabled backup left an alarm armed');
    });

    // --- acquiring a tab to work in -------------------------------------
    //
    // A scheduled backup almost never finds AI Studio already open, so it has
    // to open its own tab without disturbing whatever the user is doing. These
    // run before any AI Studio page exists, so the open-a-tab path is the one
    // under test.

    let opened;
    let activeBefore;
    let signedOut;

    // The test above left backups disabled, and a disabled backup returns
    // before it ever looks for a tab.
    await worker.evaluate(() =>
      globalThis.AISE.schedule.configure({ enabled: true, frequency: 'daily', formatId: 'markdown' })
    );

    await test('with no AI Studio tab open, it opens one in the background', async () => {
      assert.strictEqual(
        (await worker.evaluate(() => chrome.tabs.query({ url: 'https://aistudio.google.com/*' }))).length,
        0,
        'an AI Studio tab was already open, so this proves nothing'
      );

      // Registered here rather than at the top so the listener is certainly
      // still live: a runtime listener dies with the service worker, and only
      // a top-level one survives eviction.
      await worker.evaluate(() => {
        globalThis.__opened = [];
        globalThis.__removed = [];
        chrome.tabs.onCreated.addListener((tab) =>
          globalThis.__opened.push({ id: tab.id, active: tab.active, windowId: tab.windowId })
        );
        chrome.tabs.onRemoved.addListener((id) => globalThis.__removed.push(id));
      });
      activeBefore = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab ? { id: tab.id, windowId: tab.windowId } : null;
      });

      const startedAt = Date.now();
      signedOut = await worker.evaluate(() => globalThis.AISE.schedule.runBackup());
      signedOut.elapsed = Date.now() - startedAt;

      opened = await worker.evaluate(() => globalThis.__opened || []);
      assert.strictEqual(opened.length, 1, `expected one tab to be opened, saw ${opened.length}`);
      assert.strictEqual(opened[0].active, false, 'the backup tab stole focus');
    });

    await test('it leaves the user looking at the same tab', async () => {
      const activeAfter = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab ? { id: tab.id, windowId: tab.windowId } : null;
      });
      assert.deepStrictEqual(activeAfter, activeBefore, 'the active tab changed during the backup');
    });

    await test('it closes the tab it opened', async () => {
      const removed = await worker.evaluate(() => globalThis.__removed || []);
      assert.ok(removed.includes(opened[0].id), 'the backup tab was left behind');

      const left = await worker.evaluate(() => chrome.tabs.query({ url: 'https://aistudio.google.com/*' }));
      assert.strictEqual(left.length, 0, `${left.length} AI Studio tabs left open`);
    });

    await test('a signed-out browser is told to sign in, and told quickly', async () => {
      // This profile has no Google session, so AI Studio redirects the tab to
      // a sign-in page — exactly what an unattended backup meets once a
      // session expires. The extension holds no `tabs` permission and cannot
      // read the URL, so it used to wait out the full 45-second load timeout
      // and then blame the page for loading slowly.
      assert.strictEqual(signedOut.success, false, JSON.stringify(signedOut));
      assert.match(signedOut.message, /sign(ed)? ?in/i, signedOut.message);
      assert.ok(
        signedOut.elapsed < 20000,
        `took ${(signedOut.elapsed / 1000).toFixed(1)}s, which means it waited out the load timeout`
      );
    });

    await test('with no window to put a tab in, it opens one and cleans it up', async () => {
      // Chrome running with every window closed is ordinary on macOS, and is
      // what a backup scheduled for the middle of the night often finds.
      // tabs.create throws there, and the fallback has to produce a window
      // that does not appear in front of whatever else is on screen.
      await worker.evaluate(() => {
        globalThis.__realCreate = chrome.tabs.create;
        chrome.tabs.create = () => Promise.reject(new Error('No current window'));
        globalThis.__windows = [];
        chrome.windows.onCreated.addListener((w) => globalThis.__windows.push({ id: w.id, state: w.state }));
      });

      try {
        await worker.evaluate(() => globalThis.AISE.schedule.runBackup());

        const windows = await worker.evaluate(() => globalThis.__windows || []);
        assert.strictEqual(windows.length, 1, `expected one window to be opened, saw ${windows.length}`);

        const survived = await worker.evaluate(
          (id) => chrome.windows.getAll().then((all) => all.some((w) => w.id === id)),
          windows[0].id
        );
        assert.strictEqual(survived, false, 'the window it opened was left behind');
      } finally {
        await worker.evaluate(() => {
          chrome.tabs.create = globalThis.__realCreate;
        });
      }
    });

    // --- a real alarm firing --------------------------------------------
    //
    // From here an AI Studio page is open, so the backup reuses it. That is
    // not just convenience: Playwright can only fulfil requests for pages it
    // opened itself, so a tab the extension opens reaches the real Google and
    // is bounced to a sign-in page. Reusing a page means the export half of
    // the run is exercised for real; the open-a-tab half is covered above.

    const studio = await context.newPage();
    await studio.goto('https://aistudio.google.com/prompts/new_chat');

    let download;
    let state;

    await test('an alarm Chrome fires produces a backup archive', async () => {
      await worker.evaluate(
        () =>
          new Promise((resolve) =>
            chrome.storage.local.set(
              {
                backupState: {
                  enabled: true,
                  frequency: 'daily',
                  formatId: 'markdown',
                  lastRunAt: null,
                  lastResult: null,
                  exportedAt: {},
                },
              },
              resolve
            )
          )
      );

      // Chrome's scheduler owns everything from here. Nothing in this test
      // calls runBackup(); if the alarm does not fire, no download appears.
      const fired = expectDownload();
      const armedAt = Date.now();
      await worker.evaluate((name) => chrome.alarms.create(name, { delayInMinutes: 1 / 60 }), ALARM_NAME);

      download = await fired;
      console.log(`        (alarm to archive: ${((Date.now() - armedAt) / 1000).toFixed(1)}s)`);
      const target = path.join(downloadDir, download.suggestedFilename());
      await download.saveAs(target);
      download = { path: target, name: download.suggestedFilename() };

      assert.ok(fs.statSync(download.path).size > 0, 'the archive is empty');
      await waitForIdle();
    });

    await test('the archive is a library export of everything in the library', async () => {
      const JSZip = (0, eval)(fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip');
      const zip = await JSZip.loadAsync(fs.readFileSync(download.path));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

      assert.ok(download.name.startsWith('ai-studio-library-'), download.name);
      assert.ok(names.includes('index.md'), names.join(', '));
      assert.ok(names.includes('manifest.json'), names.join(', '));

      const conversations = names.filter((n) => n.endsWith('conversation.md'));
      assert.strictEqual(conversations.length, LIBRARY.length, conversations.join(', '));

      const manifest = JSON.parse(await zip.files['manifest.json'].async('string'));
      assert.strictEqual(manifest.format, 'markdown');
      assert.deepStrictEqual(manifest.failures, []);
    });

    await test('a tab the user already had open is reused, and left open', async () => {
      const before = await worker.evaluate(() => (globalThis.__opened || []).length);
      const fired = expectDownload();
      const result = await worker.evaluate(async () => {
        await globalThis.AISE.schedule.configure({ exportedAt: {} });
        return globalThis.AISE.schedule.runBackup();
      });
      assert.strictEqual(result.success, true, result.message);
      await (await fired).saveAs(path.join(downloadDir, 'reuse.zip'));
      await waitForIdle();

      const after = await worker.evaluate(() => (globalThis.__opened || []).length);
      assert.strictEqual(after, before, 'a tab was opened even though one was available');
      assert.ok(!studio.isClosed(), "the user's own tab was closed");
    });

    await test('the API was used, not the page scraper', async () => {
      assert.ok(seen.rpc.includes('ListPrompts'), 'the library was never listed');
      // Deduplicated: several backups have run by now, each fetching both.
      assert.deepStrictEqual([...new Set(seen.fetched)].sort(), LIBRARY.map((c) => c.id).sort());
    });

    await test('the run is recorded so the next one can be incremental', async () => {
      state = await worker.evaluate(
        () => new Promise((resolve) => chrome.storage.local.get({ backupState: null }, (d) => resolve(d.backupState)))
      );

      assert.ok(state.lastRunAt, 'no lastRunAt recorded');
      assert.ok(Date.now() - state.lastRunAt < 180000, 'lastRunAt is not from this run');
      assert.ok(!/^Failed:/.test(state.lastResult || ''), state.lastResult);
      // Without this, every scheduled run re-exports the whole library.
      assert.deepStrictEqual(Object.keys(state.exportedAt).sort(), LIBRARY.map((c) => c.id).sort());
    });

    await test('a second run with nothing changed exports nothing', async () => {
      // The incremental filter is the whole point of the recorded state, and it
      // is only exercised once a first run has populated it.
      const result = await worker.evaluate(() => globalThis.AISE.schedule.runBackup());
      assert.strictEqual(result.success, false, JSON.stringify(result));
      assert.match(result.message, /no conversations|nothing|unchanged/i, result.message);
    });

    await test('a changed conversation is picked up on the next run', async () => {
      LIBRARY[0].modified += 5000;
      const fired = expectDownload();
      const result = await worker.evaluate(() => globalThis.AISE.schedule.runBackup());
      assert.strictEqual(result.success, true, result.message);

      const second = await fired;
      const target = path.join(downloadDir, `second-${second.suggestedFilename()}`);
      await second.saveAs(target);
      await waitForIdle();

      const JSZip = (0, eval)(fs.readFileSync(path.join(ROOT, 'libs', 'jszip.min.js'), 'utf8') + ';JSZip');
      const zip = await JSZip.loadAsync(fs.readFileSync(target));
      const conversations = Object.keys(zip.files).filter((n) => n.endsWith('conversation.md'));
      assert.strictEqual(conversations.length, 1, `only the changed one: ${conversations.join(', ')}`);
    });
  } finally {
    await context.close();
  }

  for (const { name, error } of failures) {
    console.error(`\nFAIL  ${name}\n      ${error.stack || error.message}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
