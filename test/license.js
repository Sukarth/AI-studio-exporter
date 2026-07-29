/**
 * Licence handling tests.
 *
 * This is the path that decides whether someone who paid gets what they paid
 * for, so the cases that matter are the unhappy ones: Polar unreachable, a key
 * revoked, an activation slot that has to be released. Storage and the network
 * are faked; everything else is the real module.
 *
 * @license MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

// --- fakes --------------------------------------------------------------

let store = {};
globalThis.chrome = {
  storage: {
    local: {
      get(defaults, cb) {
        const out = {};
        for (const key of Object.keys(defaults)) {
          out[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaults[key];
        }
        cb(out);
      },
      set(values, cb) {
        Object.assign(store, values);
        if (cb) cb();
      },
    },
  },
};

let calls = [];
let respond = () => ({ ok: true, status: 200, body: { id: 'act_1' } });

globalThis.fetch = async (url, init) => {
  const call = { url, body: JSON.parse(init.body) };
  calls.push(call);
  const result = respond(call);
  if (result instanceof Error) throw result;
  return {
    ok: result.ok,
    status: result.status,
    text: async () => JSON.stringify(result.body),
  };
};

// settings.js declares AI_STUDIO_PRO as a top-level const, which under eval is
// a global lexical binding rather than a property of globalThis. license.js
// reads it by name, so the two have to share one eval realm.
const source =
  fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8').replace(
    /const AI_STUDIO_PRO = Object\.freeze\(\{[\s\S]*?\}\);/,
    "const AI_STUDIO_PRO = { purchaseUrl: 'https://example.test/buy', polarOrganizationId: 'org_test' };"
  ) + fs.readFileSync(path.join(ROOT, 'pro', 'license.js'), 'utf8');

(0, eval)(source);
const { license } = globalThis.AISE;

// resolveFormat needs a format registry; two entries is enough to gate on.
globalThis.AISE.formats = {
  markdown: { id: 'markdown', label: 'Markdown', pro: false },
  pdf: { id: 'pdf', label: 'PDF', pro: true },
};

const KEY = 'AAAA-BBBB-CCCC-DDDD';

function reset() {
  store = {};
  calls = [];
  respond = () => ({ ok: true, status: 200, body: { id: 'act_1' } });
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  reset();
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push({ name, error });
  }
}

// --- tests --------------------------------------------------------------

async function main() {
  await test('activation stores the activation id Polar returns', async () => {
    const result = await license.activate(KEY);
    assert.strictEqual(result.ok, true, result.message);
    assert.match(calls[0].url, /\/activate$/);
    assert.strictEqual(calls[0].body.organization_id, 'org_test');
    assert.strictEqual(store.proLicense.activationId, 'act_1');
    assert.strictEqual(await license.isPro({ skipRevalidation: true }), true);
  });

  await test('activation rejects a malformed key without calling Polar', async () => {
    const result = await license.activate('nope!');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls.length, 0, 'no request for something that cannot be a key');
  });

  await test('a rejected activation leaves no licence behind', async () => {
    respond = () => ({ ok: false, status: 404, body: { detail: 'License key not found.' } });
    const result = await license.activate(KEY);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message, 'License key not found.', 'Polar’s own wording reaches the user');
    assert.strictEqual(await license.isPro({ skipRevalidation: true }), false);
  });

  await test('deactivation releases the slot at Polar', async () => {
    // Activations are capped. A purely local removal burns a slot forever and
    // eventually locks out someone who paid.
    await license.activate(KEY);
    calls = [];

    const result = await license.deactivate();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1, 'Polar was told');
    assert.match(calls[0].url, /\/deactivate$/);
    assert.strictEqual(calls[0].body.activation_id, 'act_1');
    assert.strictEqual(await license.isPro({ skipRevalidation: true }), false);
  });

  await test('deactivation still works when Polar cannot be reached', async () => {
    await license.activate(KEY);
    respond = () => new Error('offline');

    const result = await license.deactivate();
    assert.strictEqual(result.ok, true, 'removing a licence must never fail');
    assert.strictEqual(store.proLicense, null, 'and it is gone locally regardless');
    assert.match(result.message, /still held/, 'but the held slot is disclosed, not hidden');
  });

  await test('a network failure never revokes a paid licence', async () => {
    await license.activate(KEY);
    // Force revalidation by ageing the stored check past the 30-day window.
    store.proLicense = Object.assign({}, store.proLicense, { lastCheckedAt: 1 });
    respond = () => new Error('offline');

    assert.strictEqual(await license.isPro(), true, 'offline is not evidence of an invalid key');
  });

  await test('an explicitly revoked key does lose Pro', async () => {
    await license.activate(KEY);
    store.proLicense = Object.assign({}, store.proLicense, { lastCheckedAt: 1 });
    respond = () => ({ ok: true, status: 200, body: { status: 'revoked' } });

    assert.strictEqual(await license.isPro(), false);
    assert.strictEqual(await license.isPro({ skipRevalidation: true }), false, 'and it stays revoked');
  });

  await test('a fresh licence is not revalidated on every call', async () => {
    await license.activate(KEY);
    calls = [];
    await license.isPro();
    assert.strictEqual(calls.length, 0, 'no network traffic for a licence checked minutes ago');
  });

  await test('status never exposes the whole key', async () => {
    await license.activate(KEY);
    const status = await license.status();
    assert.strictEqual(status.pro, true);
    assert.ok(!status.key.includes('BBBB'), 'the middle is masked');
    assert.ok(status.key.startsWith('AAAA'), 'enough to recognise which key it is');
  });

  await test('Pro formats fall back to Markdown rather than failing', async () => {
    const result = await license.resolveFormat('pdf');
    assert.strictEqual(result.format.id, 'markdown');
    assert.strictEqual(result.downgraded, true);
    assert.match(result.reason, /Pro format/);
  });

  await test('Pro formats are allowed once activated', async () => {
    await license.activate(KEY);
    const result = await license.resolveFormat('pdf');
    assert.strictEqual(result.format.id, 'pdf');
    assert.strictEqual(result.downgraded, false);
  });

  await test('free formats never touch the licence check', async () => {
    const result = await license.resolveFormat('markdown');
    assert.strictEqual(result.format.id, 'markdown');
    assert.strictEqual(result.downgraded, false);
    assert.strictEqual(calls.length, 0);
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
