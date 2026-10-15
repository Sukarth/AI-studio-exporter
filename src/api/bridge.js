/**
 * Isolated-world half of the transport bridge.
 *
 * src/api/rpc.js does the actual fetching from the MAIN world because of CORS;
 * this side wraps that in promises and exposes a normal-looking async API to
 * the rest of the content script.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});
  const { decodeConversation, decodePromptList } = AISE.decode;

  const REQUEST_TAG = 'aise:rpc:request';
  const RESPONSE_TAG = 'aise:rpc:response';
  const DEFAULT_TIMEOUT_MS = 30000;
  // Attachments can be large and Drive can be slow; give them their own budget.
  const DOWNLOAD_TIMEOUT_MS = 180000;
  const PAGE_SIZE = 100;
  // Only bounds a runaway loop if the server keeps handing back page tokens.
  // 200 pages is 20k conversations.
  const MAX_PAGES = 200;

  const pending = new Map();
  let counter = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.tag !== RESPONSE_TAG) return;

    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);

    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'Request failed'));
  });

  function send(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${counter++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${payload.op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      window.postMessage(Object.assign({ tag: REQUEST_TAG, id }, payload), location.origin);
    });
  }

  const call = (method, body) => send({ op: 'rpc', method, body }, DEFAULT_TIMEOUT_MS);

  /** True when the MAIN-world half is present and the session is authenticated. */
  async function isAvailable() {
    try {
      await call('ListPrompts', [1]);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function fetchConversation(driveId) {
    return decodeConversation(await call('ResolveDriveResource', [driveId]));
  }

  /**
   * Walk the whole library. `onPage` fires per page so callers can show
   * progress before the full listing has arrived.
   */
  async function listAllPrompts(onPage) {
    const all = [];
    let token = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = token ? [PAGE_SIZE, token] : [PAGE_SIZE];
      const { items, nextPageToken } = decodePromptList(await call('ListPrompts', body));

      all.push(...items);
      if (typeof onPage === 'function') onPage(all.length, items);

      token = nextPageToken;
      if (!token || !items.length) break;
    }

    return all;
  }

  const fetchAttachmentMetadata = (fileId) =>
    send({ op: 'drive.metadata', fileId }, DEFAULT_TIMEOUT_MS);

  const downloadAttachment = (fileId) =>
    send({ op: 'drive.download', fileId }, DOWNLOAD_TIMEOUT_MS);

  AISE.api = {
    call,
    isAvailable,
    fetchConversation,
    listAllPrompts,
    fetchAttachmentMetadata,
    downloadAttachment,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
