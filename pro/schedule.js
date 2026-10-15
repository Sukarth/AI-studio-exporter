/**
 * Scheduled library backups.
 *
 * Runs in the service worker, but the actual export cannot: fetching the API
 * requires page origin (see src/api/rpc.js), and building an archive needs a
 * DOM. So the alarm's job is to find or open an AI Studio tab and ask the
 * content script there to run an incremental batch export.
 *
 * Incremental by design. The library index reports a modified timestamp per
 * conversation, so a backup only re-fetches what changed since the last run.
 * A weekly backup of a 300-conversation library is normally a handful of
 * requests, not 300.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const ALARM_NAME = 'aise:scheduled-backup';
  const STATE_KEY = 'backupState';

  const INTERVALS = {
    daily: 24 * 60,
    weekly: 7 * 24 * 60,
    monthly: 30 * 24 * 60,
  };

  // Give the tab time to load and inject before asking it to work.
  const TAB_READY_TIMEOUT_MS = 45000;
  const TAB_POLL_MS = 750;

  const readState = () =>
    new Promise((resolve) =>
      chrome.storage.local.get({ [STATE_KEY]: null }, (d) => resolve(d[STATE_KEY] || {
        enabled: false,
        frequency: 'weekly',
        formatId: 'markdown',
        lastRunAt: null,
        lastResult: null,
        exportedAt: {},
      }))
    );

  const writeState = (state) =>
    new Promise((resolve) => chrome.storage.local.set({ [STATE_KEY]: state }, resolve));

  async function reschedule() {
    const state = await readState();
    await chrome.alarms.clear(ALARM_NAME);
    if (!state.enabled) return null;

    const periodInMinutes = INTERVALS[state.frequency] || INTERVALS.weekly;
    // delayInMinutes rather than firing immediately: enabling a backup should
    // not kick one off while the user is still on the settings page.
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 5, periodInMinutes });
    return periodInMinutes;
  }

  async function configure(patch) {
    const state = Object.assign(await readState(), patch);
    await writeState(state);
    await reschedule();
    return state;
  }

  const BACKUP_URL = 'https://aistudio.google.com/prompts/new_chat';

  /**
   * An AI Studio tab to run the export in.
   *
   * A scheduled backup almost never finds one already open, so opening one is
   * the normal path rather than the fallback. It must not interrupt whatever
   * the user is doing: the tab is created inactive, in a window that is never
   * focused, and closed again when the backup finishes.
   *
   * @returns {Promise<{tabId: number, opened: boolean, windowId: ?number}>}
   *   `opened` says whether this backup created the tab and therefore owns
   *   closing it; `windowId` is set only when a window had to be opened too.
   */
  async function acquireTab() {
    // A discarded tab (Chrome's memory saver unloads background tabs) still
    // reports status 'complete' but has no content script behind it, so
    // messaging it would stall until the timeout and then fail.
    const existing = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
    const usable = existing.find((tab) => tab.status === 'complete' && !tab.discarded);
    if (usable) return { tabId: usable.id, opened: false, windowId: null };

    // `active: false` opens the tab in the background of an existing window:
    // it appears in the tab strip but does not steal focus or change what the
    // user is looking at.
    try {
      const tab = await chrome.tabs.create({ url: BACKUP_URL, active: false });
      return { tabId: tab.id, opened: true, windowId: null };
    } catch (error) {
      // Thrown when there is no window to put a tab in; Chrome still running
      // with every window closed, which on macOS is an ordinary state and on
      // any platform is what a backup scheduled overnight tends to find.
      const window = await chrome.windows.create({
        url: BACKUP_URL,
        focused: false,
        state: 'minimized',
      });
      const tab = window.tabs && window.tabs[0];
      if (!tab) throw error;
      return { tabId: tab.id, opened: true, windowId: window.id };
    }
  }

  /**
   * Poll until the content script answers, so we never message a blank tab.
   *
   * Also watches for the tab leaving AI Studio. A profile that is signed out
   * of Google, or whose session has expired (which is what an unattended
   * backup eventually meets), is redirected to a sign-in page, where nothing
   * of ours runs. Waiting the full timeout and then reporting that AI Studio
   * "did not finish loading" is both slow and wrong.
   *
   * The extension deliberately holds no `tabs` permission, so it cannot read
   * the tab's URL to find this out. A host-filtered query answers the only
   * question that matters without one: is this tab still somewhere we are
   * allowed to reach?
   *
   * @returns {Promise<{ready: boolean, reason: ?string}>}
   */
  async function waitForContentScript(tabId) {
    const deadline = Date.now() + TAB_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
        if (response) return { ready: true, reason: null };
      } catch (_) {
        // Not injected yet.
      }

      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (_) {
        return { ready: false, reason: 'The AI Studio tab was closed before the backup could start.' };
      }

      // Only once it has settled: a tab still loading may not match the host
      // filter yet, and that is not a redirect.
      if (tab.status === 'complete') {
        const onSite = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
        if (!onSite.some((candidate) => candidate.id === tabId)) {
          return {
            ready: false,
            reason:
              'AI Studio redirected somewhere else, which normally means this browser is ' +
              'signed out of Google. Open AI Studio and sign in, and the next backup will run.',
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, TAB_POLL_MS));
    }

    return { ready: false, reason: 'AI Studio did not finish loading in time.' };
  }

  async function runBackup() {
    const state = await readState();
    if (!state.enabled) return { success: false, message: 'Scheduled backup is disabled' };

    let tabId = null;
    let openedTabId = null;
    let openedWindowId = null;

    try {
      const acquired = await acquireTab();
      tabId = acquired.tabId;
      openedTabId = acquired.opened ? acquired.tabId : null;
      openedWindowId = acquired.windowId;

      const ready = await waitForContentScript(tabId);
      if (!ready.ready) throw new Error(ready.reason);

      const result = await chrome.tabs.sendMessage(tabId, {
        action: 'exportLibrary',
        formatId: state.formatId,
        filters: {
          // Only conversations changed since we last saw them.
          skipUnchangedSince: state.exportedAt || {},
        },
        silent: true,
      });

      const next = Object.assign({}, state, {
        lastRunAt: Date.now(),
        lastResult: result && result.message ? result.message : 'No changes to back up',
        exportedAt: Object.assign({}, state.exportedAt, (result && result.exportedAt) || {}),
      });
      await writeState(next);
      return result || { success: true, message: 'Nothing to back up' };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      await writeState(Object.assign({}, state, { lastRunAt: Date.now(), lastResult: `Failed: ${message}` }));
      // Everything that fails here fails before the content script runs; no
      // tab, no sign-in, a redirect. So nothing else has badged it, and an
      // unattended backup that silently stops is a backup nobody has.
      if (AISE.badge) await AISE.badge.set('failed', `Scheduled backup: ${message}`);
      return { success: false, message };
    } finally {
      // Leave anything the user already had open exactly as it was, and clear
      // up whatever this run opened, including the window, when there was no
      // window to borrow.
      if (openedWindowId !== null) {
        try { await chrome.windows.remove(openedWindowId); } catch (_) { /* already gone */ }
      } else if (openedTabId !== null) {
        try { await chrome.tabs.remove(openedTabId); } catch (_) { /* already gone */ }
      }
    }
  }

  function register() {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) runBackup();
    });
    // Alarms do not survive an extension update, so re-arm on startup.
    chrome.runtime.onStartup.addListener(reschedule);
    chrome.runtime.onInstalled.addListener(reschedule);
  }

  AISE.schedule = { register, configure, reschedule, runBackup, readState, INTERVALS, ALARM_NAME };
})(typeof globalThis !== 'undefined' ? globalThis : self);
