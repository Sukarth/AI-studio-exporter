/**
 * End-to-end UI tests, against a real Chrome with the extension really loaded.
 *
 * This is the only suite that exercises the extension pages as Chrome actually
 * runs them: real `chrome.storage`, a real service worker, real message
 * passing between the options page and the worker. Everything else in test/
 * runs the logic in Node with those APIs faked, which cannot catch a broken
 * manifest, an unregistered listener, or a page that throws on load.
 *
 * Requires Playwright, which the rest of the suite deliberately does not:
 *
 *     npm install
 *     npx playwright install chromium
 *     npm run test:ui
 *
 * Notes for anyone changing this file:
 *
 *  - Headed only. Loading an unpacked MV3 extension headlessly does not
 *    reliably start the service worker on current Chrome, so the window has to
 *    be visible. CI needs a display (xvfb-run on Linux).
 *  - One browser launch per process. Repeated launchPersistentContext calls in
 *    a single process intermittently fail to load the extension at all.
 *  - Polar is intercepted, never called. Activations are seat-limited and a
 *    test run must not spend one.
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
  console.log('playwright not installed - run `npm install`. Skipping UI tests.');
  process.exit(0);
}

const LICENCE_KEY = 'AISE-TEST-KEY-0001';

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

/** Read a value straight out of the extension's own storage. */
const readSync = (worker, keys) =>
  worker.evaluate((k) => new Promise((r) => chrome.storage.sync.get(k, r)), keys);

const readLocal = (worker, keys) =>
  worker.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, r)), keys);

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-ui-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;

    // Polar must never be reached from a test. Each case sets the reply it
    // wants; the default is a successful activation.
    let polar = { status: 200, body: { id: 'activation_test_1' } };
    await context.route('https://api.polar.sh/**', (route) =>
      route.fulfill({
        status: polar.status,
        contentType: 'application/json',
        body: JSON.stringify(polar.body),
      })
    );

    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;

    console.log(`\nrunning against ${extensionId}\n`);

    // --- service worker -------------------------------------------------

    await test('the manifest version matches package.json', async () => {
      const version = await worker.evaluate(() => chrome.runtime.getManifest().version);
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      assert.strictEqual(version, pkg.version);
    });

    // --- options page ---------------------------------------------------

    const options = await context.newPage();
    await options.goto(optionsUrl);
    await options.waitForSelector('#saveBtn');

    await test('the service worker answers messages from an extension page', async () => {
      // Sent from the page, not from the worker: Chrome does not deliver a
      // runtime message back to the context that sent it.
      const reply = await options.evaluate(
        () => new Promise((r) => chrome.runtime.sendMessage({ action: 'backup:state' }, r))
      );
      assert.ok(reply && reply.state, 'no backup state returned');
      assert.strictEqual(reply.state.enabled, false, 'backups start off');
    });

    await test('the worker ignores an action it does not implement', async () => {
      const reply = await options.evaluate(
        () => new Promise((r) => chrome.runtime.sendMessage({ action: 'backup:nonsense' }, r))
      );
      assert.ok(!reply || !reply.state, `unimplemented action answered: ${JSON.stringify(reply)}`);
    });

    await test('the options page loads without throwing', async () => {
      const errors = [];
      options.on('pageerror', (e) => errors.push(e.message));
      await options.reload();
      await options.waitForSelector('#saveBtn');
      assert.deepStrictEqual(errors, []);
    });

    await test('saving a setting round-trips through chrome.storage.sync', async () => {
      // The bindings are derived from the defaults rather than listed, so this
      // is the check that a new setting is actually wired to its checkbox.
      const before = await options.isChecked('#includeTokenCounts');
      await options.setChecked('#includeTokenCounts', !before);
      await options.click('#saveBtn');
      await options.waitForSelector('#toast.is-shown');

      const stored = await readSync(worker, 'includeTokenCounts');
      assert.strictEqual(stored.includeTokenCounts, !before);
    });

    await test('a saved setting survives a reload of the page', async () => {
      const expected = await readSync(worker, 'includeTokenCounts');
      await options.reload();
      await options.waitForSelector('#includeTokenCounts');
      assert.strictEqual(
        await options.isChecked('#includeTokenCounts'),
        expected.includeTokenCounts
      );
    });

    await test('condense attachments defaults to on', async () => {
      const stored = await readSync(worker, 'condenseAttachments');
      assert.strictEqual(stored.condenseAttachments, true);
      assert.strictEqual(await options.isChecked('#condenseAttachments'), true);
    });

    await test('resetting restores every default', async () => {
      await options.click('#resetBtn');
      // The confirm is the extension's own dialog now, not the browser's.
      await options.click('#resetConfirm');
      await options.waitForSelector('#toast.is-shown');
      const stored = await readSync(worker, ['includeTokenCounts', 'defaultFormat']);
      assert.strictEqual(stored.includeTokenCounts, true);
      assert.strictEqual(stored.defaultFormat, 'markdown');
    });

    await test('Pro formats are visible but unselectable without a licence', async () => {
      const formats = await options.$$eval('#defaultFormat option', (nodes) =>
        nodes.map((n) => ({ value: n.value, disabled: n.disabled, label: n.textContent }))
      );
      assert.strictEqual(formats.length, 9, 'all nine formats are listed');

      const pdf = formats.find((f) => f.value === 'pdf');
      assert.ok(pdf.disabled, 'PDF is locked');
      assert.match(pdf.label, /Pro/, 'and says why');
      assert.ok(!formats.find((f) => f.value === 'markdown').disabled, 'free formats stay open');
    });

    await test('the backup section is locked without a licence', async () => {
      const locked = await options.$eval('#backupPanel', (n) => n.classList.contains('is-locked'));
      assert.strictEqual(locked, true);
    });

    // --- licensing ------------------------------------------------------

    await test('a rejected key is reported and unlocks nothing', async () => {
      polar = { status: 404, body: { detail: 'License key not found.' } };
      await options.fill('#licenseKey', 'WRONG-KEY-1234');
      await options.click('#activateBtn');
      await options.waitForSelector('#licenseNotice.is-err');

      assert.match(await options.textContent('#licenseNotice'), /not found/);
      assert.strictEqual(await options.textContent('#proBadge'), 'LOCKED');
    });

    await test('activating a licence unlocks Pro across the page', async () => {
      polar = { status: 200, body: { id: 'activation_test_1' } };
      await options.fill('#licenseKey', LICENCE_KEY);
      await options.click('#activateBtn');
      await options.waitForSelector('#proBadge.chip-ok');

      assert.strictEqual(await options.textContent('#proBadge'), 'ACTIVE');

      const pdf = await options.$eval('#defaultFormat option[value="pdf"]', (n) => n.disabled);
      assert.strictEqual(pdf, false, 'Pro formats became selectable');

      const locked = await options.$eval('#backupPanel', (n) => n.classList.contains('is-locked'));
      assert.strictEqual(locked, false, 'and the backup controls unlocked');
    });

    await test('the stored licence never keeps more than it needs', async () => {
      const { proLicense } = await readLocal(worker, 'proLicense');
      assert.strictEqual(proLicense.valid, true);
      assert.strictEqual(proLicense.activationId, 'activation_test_1');
      assert.ok(proLicense.activatedAt > 0);
    });

    await test('the displayed key is masked', async () => {
      const shown = await options.textContent('#licenseMasked');
      assert.ok(shown.startsWith('AISE'), 'enough to recognise');
      assert.ok(!shown.includes('TEST-KEY'), 'but not enough to copy');
    });

    // --- scheduled backup -----------------------------------------------

    await test('enabling a backup creates a real chrome alarm', async () => {
      await options.selectOption('#backupFrequency', 'daily');
      await options.check('#backupEnabled');
      await options.waitForSelector('#backupNotice:not([hidden])');

      const alarm = await worker.evaluate(() => chrome.alarms.get('aise:scheduled-backup'));
      assert.ok(alarm, 'no alarm registered');
      assert.strictEqual(alarm.periodInMinutes, 1440, 'daily');
    });

    await test('disabling a backup clears the alarm', async () => {
      await options.uncheck('#backupEnabled');
      await options.waitForFunction(
        () => /\boff\b/i.test(document.getElementById('backupNotice').textContent)
      );
      const alarm = await worker.evaluate(() => chrome.alarms.get('aise:scheduled-backup'));
      assert.ok(!alarm, 'alarm outlived the setting');
    });

    // --- popup ----------------------------------------------------------

    const popup = await context.newPage();

    await test('the popup loads without throwing', async () => {
      const errors = [];
      popup.on('pageerror', (e) => errors.push(e.message));
      await popup.goto(popupUrl);
      await popup.waitForSelector('#exportBtn');
      assert.deepStrictEqual(errors, []);
    });

    await test('the popup refuses to export away from AI Studio', async () => {
      assert.match(await popup.textContent('#blockedBody'), /Open aistudio\.google\.com/);
      assert.strictEqual(await popup.isDisabled('#exportBtn'), true);
      assert.strictEqual(await popup.isDisabled('#exportLibraryBtn'), true);
    });

    await test('the popup shows every format, with Pro unlocked by the licence', async () => {
      // A listbox rather than a <select>, so that locked formats can carry a
      // PRO chip instead of vanishing.
      const formats = await popup.$$eval('#formatList .picker-opt', (nodes) =>
        nodes.map((n) => ({
          value: n.dataset.value,
          locked: n.getAttribute('aria-disabled') === 'true',
        }))
      );
      assert.strictEqual(formats.length, 9);
      assert.strictEqual(formats.find((f) => f.value === 'docx').locked, false);
    });

    await test('the popup hides the upgrade link once Pro is active', async () => {
      assert.strictEqual(await popup.isHidden('#upgradeLink'), true);
      assert.strictEqual(await popup.isHidden('#libraryProBadge'), true);
    });

    // --- deactivation ---------------------------------------------------

    await test('removing a licence releases the activation at Polar', async () => {
      const seen = [];
      await context.route('https://api.polar.sh/**', (route) => {
        seen.push(route.request().url());
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await options.bringToFront();
      // The confirm is the extension's own dialog now, not the browser's.
      await options.click('#deactivateBtn');
      await options.click('#resetConfirm');
      await options.waitForFunction(() => document.getElementById('proBadge').textContent === 'LOCKED');

      assert.ok(seen.some((url) => url.endsWith('/deactivate')), `no deactivate call: ${seen}`);
      const { proLicense } = await readLocal(worker, 'proLicense');
      assert.strictEqual(proLicense, null, 'and the licence is gone locally');
    });

    await test('Pro locks again after removal', async () => {
      const pdf = await options.$eval('#defaultFormat option[value="pdf"]', (n) => n.disabled);
      assert.strictEqual(pdf, true);
    });

    await test('locked formats stay listed in the popup, chipped rather than hidden', async () => {
      // Reopened now that the licence is gone: hiding Pro formats entirely
      // means nobody discovers what Pro buys, so they stay visible.
      await popup.goto(popupUrl);
      await popup.waitForSelector('#formatList .picker-opt', { state: 'attached' });
      const free = await popup.$$eval('#formatList .picker-opt', (nodes) =>
        nodes.map((n) => ({
          value: n.dataset.value,
          locked: n.getAttribute('aria-disabled') === 'true',
          chip: !!n.querySelector('.chip'),
        }))
      );
      assert.strictEqual(free.length, 9, 'nothing is hidden');
      const pdf = free.find((f) => f.value === 'pdf');
      assert.strictEqual(pdf.locked, true);
      assert.strictEqual(pdf.chip, true, 'and it says why');
      assert.strictEqual(free.find((f) => f.value === 'markdown').locked, false);
    });

    await test('the settings page reads the licence back masked, not editable', async () => {
      await options.reload();
      await options.waitForSelector('#licenseEntry');
      assert.strictEqual(await options.isHidden('#licenseActive'), true, 'no active panel without a licence');
      assert.strictEqual(await options.isVisible('#licenseEntry'), true);
    });
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
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
