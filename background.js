/**
 * Service worker.
 *
 * Owns only what must outlive a page: the backup alarm. Exporting itself
 * happens in the content script, because the API needs page origin and archive
 * building needs a DOM.
 *
 * @license MIT
 */

importScripts('pro/schedule.js');

const AISE = globalThis.AISE;

AISE.schedule.register();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') {
    // Alarms do not survive an update; schedule.register() re-arms via its own
    // onInstalled listener, so nothing more is needed here.
    console.log('[AI Studio Exporter] updated to', chrome.runtime.getManifest().version);
  }
});

// Messages from the options page, which cannot reach chrome.alarms itself.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ success: false, message: 'Invalid sender' });
    return false;
  }
  if (!request || typeof request.action !== 'string') {
    sendResponse({ success: false, message: 'Invalid request' });
    return false;
  }

  switch (request.action) {
    case 'backup:configure':
      AISE.schedule.configure(request.patch || {}).then((state) => sendResponse({ success: true, state }));
      return true;
    case 'backup:state':
      AISE.schedule.readState().then((state) => sendResponse({ success: true, state }));
      return true;
    case 'backup:runNow':
      AISE.schedule.runBackup().then(sendResponse);
      return true;
    default:
      return false;
  }
});

console.log('[AI Studio Exporter] service worker ready');
