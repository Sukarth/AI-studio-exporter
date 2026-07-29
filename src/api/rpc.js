/**
 * MakerSuite RPC client. Runs in the MAIN world.
 *
 * Why MAIN and not the isolated content-script world: the endpoint replies with
 * `Access-Control-Allow-Origin: https://aistudio.google.com`. A fetch issued
 * from the isolated world carries the extension's origin and is rejected by
 * CORS, so the request has to originate from the page itself. Running here also
 * gives us `document.cookie`, which is where SAPISID lives.
 *
 * Nothing in this file is reachable from the page's own code — it only ever
 * acts on messages that came from our isolated-world bridge (same-window,
 * same-origin, correct tag), and it only ever talks to the one Google endpoint.
 *
 * @license MIT
 */
(function () {
  'use strict';

  const ORIGIN = 'https://aistudio.google.com';
  const ENDPOINT =
    'https://alkalimakersuite-pa.clients6.google.com/$rpc/' +
    'google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';

  // The public web-client key shipped in the AI Studio bundle. Kept as a
  // fallback only — findApiKey() prefers whatever the live page is using so a
  // rotation on Google's side doesn't strand us on a stale constant.
  const FALLBACK_API_KEY = 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs';
  const API_KEY_PATTERN = /["'](AIza[\w-]{35})["']/;

  const REQUEST_TAG = 'aise:rpc:request';
  const RESPONSE_TAG = 'aise:rpc:response';

  // Only these may be invoked from the bridge. Both are reads; nothing here can
  // create, mutate or delete a prompt.
  const ALLOWED_METHODS = new Set(['ListPrompts', 'ResolveDriveResource']);

  let cachedApiKey = null;

  function readCookie(name) {
    const prefix = name + '=';
    const hit = document.cookie.split('; ').find((c) => c.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  }

  /** Scan inline scripts for the live API key, falling back to the constant. */
  function findApiKey() {
    if (cachedApiKey) return cachedApiKey;
    for (const script of document.querySelectorAll('script:not([src])')) {
      const match = API_KEY_PATTERN.exec(script.textContent || '');
      if (match) {
        cachedApiKey = match[1];
        return cachedApiKey;
      }
    }
    cachedApiKey = FALLBACK_API_KEY;
    return cachedApiKey;
  }

  /** AI Studio puts the signed-in account index in the path as /u/<n>/. */
  function findAuthUser() {
    const match = /^\/u\/(\d+)\//.exec(location.pathname);
    return match ? match[1] : '0';
  }

  async function sha1Hex(input) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Google's SAPISIDHASH scheme: SHA-1 over "<unixSeconds> <SAPISID> <origin>".
   * This is the same construction the AI Studio frontend performs; we are not
   * minting credentials, just re-deriving the header for the session that is
   * already signed in.
   */
  async function buildAuthHeader() {
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) {
      throw new Error('Not signed in to Google (no SAPISID cookie)');
    }
    const seconds = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${seconds} ${sapisid} ${ORIGIN}`);
    return `SAPISIDHASH ${seconds}_${hash}`;
  }

  async function callRpc(method, body) {
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Refusing to call non-allowlisted RPC method: ${method}`);
    }

    const response = await fetch(ENDPOINT + method, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': findApiKey(),
        'x-goog-authuser': findAuthUser(),
        'x-user-agent': 'grpc-web-javascript/0.1',
        authorization: await buildAuthHeader(),
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      // Errors come back as [code, "message"].
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && typeof parsed[1] === 'string') detail = parsed[1];
      } catch (_) { /* keep the raw prefix */ }
      throw new Error(`${method} failed (${response.status}): ${detail}`);
    }

    return JSON.parse(text);
  }

  window.addEventListener('message', async (event) => {
    // Must be our own window, our own origin, and our own tag. Anything else is
    // page script or another extension and gets ignored silently.
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.tag !== REQUEST_TAG || typeof data.id !== 'string') return;

    const reply = (payload) =>
      window.postMessage(Object.assign({ tag: RESPONSE_TAG, id: data.id }, payload), location.origin);

    try {
      reply({ ok: true, result: await callRpc(data.method, data.body) });
    } catch (error) {
      reply({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  });
})();
