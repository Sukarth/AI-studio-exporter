/**
 * Toolbar badge tests.
 *
 * The badge is the only thing that reports an unattended export, so the cases
 * worth pinning down are the ones where it must *not* disappear: a failure
 * stays until the popup acknowledges it, and a service worker restart repaints
 * whatever was still owed. chrome.action and chrome.storage are faked;
 * everything else is the real module.
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
let painted = [];
let now = 1_000_000;

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
  action: {
    async setBadgeText({ text }) {
      painted.push({ text });
    },
    async setBadgeBackgroundColor({ color }) {
      painted[painted.length - 1].color = color;
    },
    async setBadgeTextColor({ color }) {
      painted[painted.length - 1].textColor = color;
    },
    async setTitle({ title }) {
      painted[painted.length - 1].title = title;
    },
  },
};

// The module stamps times with Date.now(); freezing it makes the expiry
// window something a test can step over rather than sleep through.
const realNow = Date.now;
Date.now = () => now;

// setTimeout would fire the auto-clear inside the test process; the paths that
// matter are the stored expiry and restore(), so the timer is a no-op here.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;

(0, eval)(fs.readFileSync(path.join(ROOT, 'src', 'badge.js'), 'utf8'));
globalThis.setTimeout = realSetTimeout;
const { badge } = globalThis.AISE;

function reset() {
  store = {};
  painted = [];
  now = 1_000_000;
}

const last = () => painted[painted.length - 1];

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
  // --- grading an outcome ---

  await test('a clean export is a tick', () => {
    assert.strictEqual(badge.outcomeFor({ success: true, source: 'api' }, false), 'done');
  });

  await test('a failed export is a cross', () => {
    assert.strictEqual(badge.outcomeFor({ success: false }, false), 'failed');
    assert.strictEqual(badge.outcomeFor(null, false), 'failed');
  });

  await test('a licence downgrade is a cross even though a file was produced', () => {
    assert.strictEqual(badge.outcomeFor({ success: true, source: 'api' }, true), 'failed');
  });

  await test('reading the page instead of the API is a warning, not a success', () => {
    assert.strictEqual(badge.outcomeFor({ success: true, source: 'dom' }, false), 'partial');
  });

  await test('unavailable attachments downgrade a success to a warning', () => {
    assert.strictEqual(
      badge.outcomeFor({ success: true, source: 'api', attachmentFailures: 2 }, false),
      'partial'
    );
  });

  await test('a library export with failures is a warning', () => {
    assert.strictEqual(
      badge.outcomeFor({ success: true, failures: [{ id: 'a', error: 'nope' }] }, false),
      'partial'
    );
    assert.strictEqual(badge.outcomeFor({ success: true, failures: [] }, false), 'done');
  });

  await test('a format warning is a warning', () => {
    assert.strictEqual(badge.outcomeFor({ success: true, warning: 'non-Latin text' }, false), 'partial');
    assert.strictEqual(badge.outcomeFor({ success: true, warnings: ['non-Latin text'] }, false), 'partial');
  });

  // --- painting ---

  await test('every state paints a glyph, a colour and a title', async () => {
    for (const state of ['running', 'reading', 'done', 'partial', 'failed']) {
      painted = [];
      await badge.set(state);
      assert.ok(last().text, `${state} has no glyph`);
      assert.match(last().color, /^#[0-9A-F]{6}$/, `${state} has no colour`);
      assert.strictEqual(last().textColor, '#FFFFFF');
      assert.ok(last().title.length > 10, `${state} has no tooltip`);
    }
  });

  await test('the tooltip carries the result message when there is one', async () => {
    await badge.set('failed', 'No messages found in this conversation.');
    assert.match(last().title, /No messages found/);
  });

  await test('the five states use five distinct glyphs', () => {
    const glyphs = ['running', 'reading', 'done', 'partial', 'failed'].map((s) => badge.describe(s).text);
    assert.strictEqual(new Set(glyphs).size, 5, `not distinct: ${glyphs.join(' ')}`);
  });

  await test('an unknown state clears the badge rather than painting nonsense', async () => {
    await badge.set('nonsense');
    assert.strictEqual(last().text, '');
  });

  // --- stickiness ---

  await test('a failure survives a service worker restart', async () => {
    await badge.set('failed', 'Export cancelled');
    painted = [];
    await badge.restore();
    assert.strictEqual(last().text, 'X');
    assert.match(last().title, /Export cancelled/);
  });

  await test('a failure stays put no matter how much time passes', async () => {
    await badge.set('failed', 'boom');
    now += 30 * 24 * 60 * 60 * 1000;
    painted = [];
    await badge.restore();
    assert.strictEqual(last().text, 'X');
  });

  await test('opening the popup clears a failure, and it stays cleared', async () => {
    await badge.set('failed', 'boom');
    const status = await badge.seen();
    assert.strictEqual(status.seen, true);
    assert.strictEqual(last().text, '');

    painted = [];
    await badge.restore();
    assert.strictEqual(last().text, '', 'a seen failure must not come back');
  });

  await test('the popup still reads the message back after acknowledging it', async () => {
    await badge.set('failed', 'Library export requires a Pro licence.');
    await badge.seen();
    const status = await badge.read();
    assert.strictEqual(status.text, 'Library export requires a Pro licence.');
    assert.strictEqual(status.state, 'failed');
  });

  // --- self-clearing ---

  await test('a tick expires on its own', async () => {
    await badge.set('done', 'Exported 42 messages');
    assert.strictEqual(badge.shouldShow(await badge.read(), now), true);

    now += badge.DONE_VISIBLE_MS + 1;
    assert.strictEqual(badge.shouldShow(await badge.read(), now), false);

    painted = [];
    await badge.restore();
    assert.strictEqual(last().text, '', 'an expired tick must not be repainted');
  });

  await test('a running badge left behind by a closed tab is not sticky', async () => {
    await badge.set('running');
    const status = await badge.read();
    assert.strictEqual(status.seen, true, 'nothing to acknowledge while it is still running');
  });

  await test('an idle status shows nothing', () => {
    assert.strictEqual(badge.shouldShow(badge.emptyStatus(), now), false);
    assert.strictEqual(badge.shouldShow(null, now), false);
  });

  // --- popup tone ---

  await test('each terminal state maps to a popup message style', () => {
    assert.strictEqual(badge.toneFor('done'), 'success');
    assert.strictEqual(badge.toneFor('partial'), 'warn');
    assert.strictEqual(badge.toneFor('failed'), 'error');
  });

  // --- documentation ---

  await test('every state is documented in docs/badges.md', () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'badges.md'), 'utf8');
    for (const state of Object.keys(badge.STATES)) {
      if (state === 'idle') continue;
      const spec = badge.STATES[state];
      assert.ok(docs.includes(spec.color), `${state}'s colour ${spec.color} is undocumented`);
      assert.ok(docs.includes(state), `${state} is undocumented`);
    }
  });

  Date.now = realNow;

  for (const { name, error } of failures) {
    console.error(`FAIL ${name}\n  ${error && error.message}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
