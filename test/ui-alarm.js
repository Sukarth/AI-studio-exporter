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

  const context = await chromium.launchPersistentContext(userDataDir, {
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

    // A tab for the backup to find. Opening its own would work too, but this
    // keeps the run deterministic and exercises the path users actually hit.
    const page = await context.newPage();
    await page.goto('https://aistudio.google.com/prompts/new_chat');

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

    // --- a real alarm firing --------------------------------------------

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
      const fired = context.waitForEvent('download', { timeout: 120000 });
      const armedAt = Date.now();
      await worker.evaluate((name) => chrome.alarms.create(name, { delayInMinutes: 1 / 60 }), ALARM_NAME);

      download = await fired;
      console.log(`        (alarm to archive: ${((Date.now() - armedAt) / 1000).toFixed(1)}s)`);
      const target = path.join(downloadDir, download.suggestedFilename());
      await download.saveAs(target);
      download = { path: target, name: download.suggestedFilename() };

      assert.ok(fs.statSync(download.path).size > 0, 'the archive is empty');
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

    await test('the API was used, not the page scraper', async () => {
      assert.ok(seen.rpc.includes('ListPrompts'), 'the library was never listed');
      assert.deepStrictEqual(seen.fetched.sort(), LIBRARY.map((c) => c.id).sort());
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
      const fired = context.waitForEvent('download', { timeout: 120000 });
      const result = await worker.evaluate(() => globalThis.AISE.schedule.runBackup());
      assert.strictEqual(result.success, true, result.message);

      const second = await fired;
      const target = path.join(downloadDir, `second-${second.suggestedFilename()}`);
      await second.saveAs(target);

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
