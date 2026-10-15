/**
 * Toolbar badge: the extension's only always-visible surface.
 *
 * The popup closes the instant an export starts (it would be destroyed on blur
 * anyway) and the in-page overlay is suppressed for scheduled backups, so
 * without this there is no way to learn that a background export finished, let
 * alone that it failed. The badge carries that: one glyph, one colour, and a
 * stored result the popup reads back.
 *
 * Two of the five states are *sticky*: they stay until the popup is opened,
 * because "something needs your attention" is worthless if it vanishes while
 * the user is in another tab. The rest clear themselves.
 *
 * Only the service worker may call apply(); chrome.action does not exist in a
 * content script. Everything else here is pure, so the states can be tested
 * without a browser.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const STORAGE_KEY = 'runStatus';

  /** How long a clean success stays up before clearing itself. */
  const DONE_VISIBLE_MS = 5000;

  /**
   * Glyphs are deliberately plain. A badge is 16 px of a font the extension
   * does not control, so anything beyond `…`, `~`, `✓`, `!` and `X` risks
   * rendering as a tofu box on some platform.
   */
  const STATES = {
    idle: {
      text: '',
      color: null,
      sticky: false,
      title: 'AI Studio Exporter',
    },
    running: {
      text: '…',
      color: '#6F757D',
      ink: '#FFFFFF',
      sticky: false,
      title: 'Exporting… reading through the AI Studio API.',
    },
    reading: {
      text: '~',
      color: '#D9A34A',
      ink: '#1A1305',
      sticky: false,
      title:
        'Exporting… the API was unavailable, so the page is being read instead. ' +
        'Token counts, model settings and the system instruction will be missing.',
    },
    done: {
      text: '✓',
      color: '#5CC98A',
      ink: '#06170E',
      sticky: false,
      clearAfterMs: DONE_VISIBLE_MS,
      title: 'Export finished.',
    },
    partial: {
      text: '!',
      color: '#D9A34A',
      ink: '#1A1305',
      sticky: true,
      title: 'Export finished, but not completely. Open the popup for details.',
    },
    failed: {
      text: 'X',
      color: '#E8736B',
      ink: '#1A0B0A',
      sticky: true,
      title: 'Export did not finish. Open the popup for details.',
    },
  };

  const describe = (state) => STATES[state] || STATES.idle;

  /**
   * Which badge an outcome deserves.
   *
   * A licence downgrade counts as `failed` even though a file was produced:
   * the user asked for PDF and got Markdown, and finding that out from the
   * downloads folder a week later is worse than a red badge now.
   *
   * @param {?object} result - what the export returned
   * @param {boolean} [downgraded] - a Pro format was substituted
   * @returns {'done'|'partial'|'failed'}
   */
  function outcomeFor(result, downgraded) {
    if (!result || !result.success) return 'failed';
    if (downgraded) return 'failed';
    // Read from the page rather than the API: the file is real but thinner.
    if (result.source === 'dom') return 'partial';
    if (result.attachmentFailures) return 'partial';
    if (Array.isArray(result.failures) && result.failures.length) return 'partial';
    if (Array.isArray(result.warnings) && result.warnings.length) return 'partial';
    if (result.warning) return 'partial';
    return 'done';
  }

  /** The message class the popup should render a stored result with. */
  const toneFor = (state) =>
    ({ done: 'success', partial: 'warn', failed: 'error' }[state] || 'info');

  const emptyStatus = () => ({ state: 'idle', text: '', at: null, seen: true, expiresAt: null });

  const read = () =>
    new Promise((resolve) =>
      chrome.storage.local.get({ [STORAGE_KEY]: null }, (d) => resolve(d[STORAGE_KEY] || emptyStatus()))
    );

  const write = (status) =>
    new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: status }, resolve));

  /**
   * Whether a stored status should still be showing.
   *
   * Sticky states show until seen; `done` shows until it expires. Anything
   * else, including a `running` state left behind by an export whose tab was
   * closed, is only shown while it is fresh, so a crashed run cannot leave a
   * spinner-ish badge up forever.
   */
  function shouldShow(status, now) {
    if (!status || status.state === 'idle') return false;
    const spec = describe(status.state);
    if (spec.sticky) return !status.seen;
    if (status.expiresAt) return now < status.expiresAt;
    return true;
  }

  async function paint(state, text) {
    const spec = describe(state);
    await chrome.action.setBadgeText({ text: spec.text });
    if (spec.color) await chrome.action.setBadgeBackgroundColor({ color: spec.color });
    // Chrome picks a contrasting colour on its own, but not the same one on
    // every platform; pinning it keeps the amber and red legible.
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: spec.ink || '#FFFFFF' });
    }
    await chrome.action.setTitle({
      title: text ? `AI Studio Exporter: ${text}` : spec.title,
    });
  }

  let clearTimer = null;

  /**
   * Record an outcome and show it.
   * @param {string} state - a key of STATES
   * @param {string} [text] - result message, kept for the popup to read back
   * @param {string} [kind] - what happened, when the state alone is too coarse.
   *   'downgrade' is the only one so far: the badge is red because you did not
   *   get what you asked for, but the popup has room to say a file still
   *   exists and offer the way out, so it renders it amber.
   */
  async function set(state, text, kind) {
    const spec = describe(state);
    const now = Date.now();
    const status = {
      state,
      kind: kind || null,
      text: text || '',
      at: now,
      // Only sticky states wait to be acknowledged; marking the rest seen up
      // front means opening the popup never has to decide whether it counts.
      seen: !spec.sticky,
      expiresAt: spec.clearAfterMs ? now + spec.clearAfterMs : null,
    };

    await write(status);
    await paint(state, text);

    if (clearTimer) clearTimeout(clearTimer);
    if (spec.clearAfterMs) {
      // Belt and braces: the service worker may be suspended before this
      // fires, so restore() re-checks the expiry on the way back up.
      clearTimer = setTimeout(() => paint('idle').catch(() => {}), spec.clearAfterMs);
    }
    return status;
  }

  /** The popup has been opened; acknowledge whatever was waiting. */
  async function seen() {
    const status = await read();
    if (status.seen && !shouldShow(status, Date.now())) {
      await paint('idle');
      return status;
    }
    const next = Object.assign({}, status, { seen: true });
    await write(next);
    await paint('idle');
    return next;
  }

  /** Re-apply the stored badge after the service worker restarts. */
  async function restore() {
    const status = await read();
    if (!shouldShow(status, Date.now())) {
      await paint('idle');
      return status;
    }
    await paint(status.state, status.text);
    return status;
  }

  AISE.badge = {
    STATES,
    STORAGE_KEY,
    DONE_VISIBLE_MS,
    describe,
    outcomeFor,
    toneFor,
    shouldShow,
    emptyStatus,
    read,
    set,
    seen,
    restore,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
