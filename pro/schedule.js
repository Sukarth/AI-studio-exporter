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

  /** An existing AI Studio tab if there is one, otherwise a new background tab. */
  async function acquireTab() {
    const existing = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
    const usable = existing.find((tab) => tab.status === 'complete');
    if (usable) return { tabId: usable.id, opened: false };

    const tab = await chrome.tabs.create({
      url: 'https://aistudio.google.com/prompts/new_chat',
      active: false,
    });
    return { tabId: tab.id, opened: true };
  }

  /** Poll until the content script answers, so we never message a blank tab. */
  async function waitForContentScript(tabId) {
    const deadline = Date.now() + TAB_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
        if (response) return true;
      } catch (_) {
        // Not injected yet.
      }
      await new Promise((resolve) => setTimeout(resolve, TAB_POLL_MS));
    }
    return false;
  }

  async function runBackup() {
    const state = await readState();
    if (!state.enabled) return { success: false, message: 'Scheduled backup is disabled' };

    let tabId = null;
    let openedByUs = false;

    try {
      const acquired = await acquireTab();
      tabId = acquired.tabId;
      openedByUs = acquired.opened;

      if (!(await waitForContentScript(tabId))) {
        throw new Error('AI Studio did not finish loading in time');
      }

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
      return { success: false, message };
    } finally {
      // Leave tabs the user already had open exactly as they were.
      if (openedByUs && tabId !== null) {
        try { await chrome.tabs.remove(tabId); } catch (_) { /* already gone */ }
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
