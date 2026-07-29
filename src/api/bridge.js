/**
 * Isolated-world half of the RPC bridge.
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
  const TIMEOUT_MS = 30000;
  const PAGE_SIZE = 100;
  // ListPrompts paginates; this only bounds a runaway loop if the server keeps
  // handing back tokens. 200 pages is 20k conversations.
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
    else entry.reject(new Error(data.error || 'RPC failed'));
  });

  function call(method, body) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${counter++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });
      window.postMessage({ tag: REQUEST_TAG, id, method, body }, location.origin);
    });
  }

  /** True when the MAIN-world half is present and authenticated. */
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
   * Walk the whole library. `onPage` is invoked per page so callers can show
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

  AISE.api = { call, isAvailable, fetchConversation, listAllPrompts };
})(typeof globalThis !== 'undefined' ? globalThis : self);
