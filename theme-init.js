/**
 * Paint the right theme before the first frame.
 *
 * This runs synchronously in <head>, ahead of any stylesheet-dependent layout,
 * which chrome.storage cannot: its API is callback-based, so a page that waited
 * for it would paint dark first and flip to light a frame later. So the
 * resolved theme is mirrored into localStorage, which is readable synchronously,
 * and the settings pages correct it from storage.sync a moment after load.
 *
 * The attribute is always concrete. "system" is resolved here rather than in
 * CSS, so the stylesheet declares each palette exactly once.
 *
 * @license MIT
 */
(function () {
  'use strict';

  var KEY = 'aise-theme';
  var LIGHT = '(prefers-color-scheme: light)';

  function systemTheme() {
    try {
      return window.matchMedia(LIGHT).matches ? 'light' : 'dark';
    } catch (error) {
      return 'dark';
    }
  }

  /** @param {string} pref - 'system' | 'dark' | 'light' */
  function apply(pref) {
    var resolved = pref === 'light' || pref === 'dark' ? pref : systemTheme();
    document.documentElement.dataset.theme = resolved;
    return resolved;
  }

  var preference = 'system';
  try {
    preference = localStorage.getItem(KEY) || 'system';
  } catch (error) {
    // Storage can be unavailable; the system default is a fine answer.
  }
  apply(preference);

  /**
   * Follow the OS while the preference is "system", and only then. A page left
   * open across a scheduled dark-mode switch should not stay stale.
   */
  try {
    window.matchMedia(LIGHT).addEventListener('change', function () {
      var current = 'system';
      try {
        current = localStorage.getItem(KEY) || 'system';
      } catch (error) {
        /* fall through to system */
      }
      if (current === 'system') apply('system');
    });
  } catch (error) {
    // Safari-era addListener is not worth carrying for a Chrome extension.
  }

  window.AISE_THEME = {
    KEY: KEY,
    apply: apply,
    system: systemTheme,
    /** Persist the preference and repaint. Storage.sync is written by callers. */
    set: function (pref) {
      try {
        localStorage.setItem(KEY, pref);
      } catch (error) {
        /* the attribute below still takes effect for this page */
      }
      return apply(pref);
    },
  };

  /**
   * Correct a stale paint the moment storage says otherwise.
   *
   * Two ways to get one. chrome.storage.sync.set is asynchronous, so a popup
   * opened in the instant after the settings page writes can read the previous
   * value and cache it back. And a change made on another machine arrives here
   * long after this page loaded. Both leave the local cache wrong, and both are
   * fixed by the same listener; without it the first is sticky rather than
   * momentary, because the stale value gets written back to the cache.
   */
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync' || !changes.theme) return;
      var next = changes.theme.newValue || 'system';
      try {
        localStorage.setItem(KEY, next);
      } catch (error) {
        /* the attribute below still takes effect for this page */
      }
      apply(next);
    });
  } catch (error) {
    // No extension APIs here; nothing to stay in step with.
  }
})();
