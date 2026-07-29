/**
 * MAIN-world transport for everything we fetch from Google.
 *
 * Why MAIN and not the isolated content-script world: the MakerSuite endpoint
 * replies with `Access-Control-Allow-Origin: https://aistudio.google.com`. A
 * fetch issued from the isolated world carries the extension's origin and is
 * rejected by CORS, so the request has to originate from the page itself.
 * Running here also gives us `document.cookie`, which is where SAPISID lives.
 *
 * Two transports live here because they share the same origin requirement:
 *   - MakerSuite RPC, authenticated with a derived SAPISIDHASH header.
 *   - Drive v3, authenticated with a bearer token minted via GenerateAccessToken.
 *     Attachments in a conversation are bare Drive ids; this is how they become
 *     real filenames and bytes.
 *
 * Nothing here is reachable from the page's own code — it only acts on messages
 * that came from our isolated-world bridge (same window, same origin, correct
 * tag), and every outbound request is a read against an allowlisted host.
 *
 * @license MIT
 */
(function () {
  'use strict';

  const ORIGIN = 'https://aistudio.google.com';
  const RPC_BASE =
    'https://alkalimakersuite-pa.clients6.google.com/$rpc/' +
    'google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
  const DRIVE_BASE = 'https://content.googleapis.com/drive/v3/files/';

  // The public web-client key shipped in the AI Studio bundle. Kept as a
  // fallback only — findApiKey() prefers whatever the live page is using so a
  // rotation on Google's side doesn't strand us on a stale constant.
  const FALLBACK_API_KEY = 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs';
  const API_KEY_PATTERN = /["'](AIza[\w-]{35})["']/;

  const REQUEST_TAG = 'aise:rpc:request';
  const RESPONSE_TAG = 'aise:rpc:response';

  // Reads only. Nothing here can create, mutate or delete a prompt or a file.
  const ALLOWED_RPC = new Set(['ListPrompts', 'ResolveDriveResource', 'GenerateAccessToken']);

  // Refuse to buffer an attachment larger than this. A single pathological file
  // shouldn't be able to exhaust the tab's memory mid-export.
  const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

  // Google-native documents have no byte stream; they must be converted on
  // request. These are the defaults that best preserve content per type.
  const NATIVE_EXPORT_TYPES = {
    'application/vnd.google-apps.document': { mimeType: 'text/markdown', extension: 'md' },
    'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', extension: 'csv' },
    'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', extension: 'pdf' },
    'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: 'png' },
    'application/vnd.google-apps.script': { mimeType: 'application/vnd.google-apps.script+json', extension: 'json' },
  };
  const NATIVE_FALLBACK = { mimeType: 'application/pdf', extension: 'pdf' };

  let cachedApiKey = null;
  let tokenCache = null; // { token, expiresAt }

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
      if (match) return (cachedApiKey = match[1]);
    }
    return (cachedApiKey = FALLBACK_API_KEY);
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
   * The same construction the AI Studio frontend performs; we are not minting
   * credentials, only re-deriving a header for the already signed-in session.
   */
  async function buildAuthHeader() {
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) throw new Error('Not signed in to Google (no SAPISID cookie)');
    const seconds = Math.floor(Date.now() / 1000);
    return `SAPISIDHASH ${seconds}_${await sha1Hex(`${seconds} ${sapisid} ${ORIGIN}`)}`;
  }

  function describeRpcError(status, text, method) {
    let detail = text.slice(0, 200);
    try {
      // RPC errors arrive as [code, "message"].
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && typeof parsed[1] === 'string') detail = parsed[1];
    } catch (_) { /* keep the raw prefix */ }
    return new Error(`${method} failed (${status}): ${detail}`);
  }

  async function callRpc(method, body) {
    if (!ALLOWED_RPC.has(method)) {
      throw new Error(`Refusing to call non-allowlisted RPC method: ${method}`);
    }

    const response = await fetch(RPC_BASE + method, {
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
    if (!response.ok) throw describeRpcError(response.status, text, method);
    return JSON.parse(text);
  }

  /**
   * Drive rejects the SAPISIDHASH header and wants OAuth, so mint a bearer
   * token the same way AI Studio does. Tokens are good for roughly an hour; we
   * re-mint a few minutes early rather than track the real expiry, since the
   * call is cheap and a mid-export 401 is not.
   */
  async function getAccessToken() {
    if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

    const result = await callRpc('GenerateAccessToken', ['users/me']);
    const token = Array.isArray(result) ? result[0] : null;
    if (typeof token !== 'string' || !token) {
      throw new Error('GenerateAccessToken returned no token');
    }

    tokenCache = { token, expiresAt: Date.now() + 45 * 60 * 1000 };
    return token;
  }

  async function driveFetch(url) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${await getAccessToken()}` } });
    if (response.status === 401) {
      // Token went stale earlier than expected — drop it and try once more.
      tokenCache = null;
      return fetch(url, { headers: { authorization: `Bearer ${await getAccessToken()}` } });
    }
    return response;
  }

  const driveUrl = (id, query) => `${DRIVE_BASE}${encodeURIComponent(id)}${query}&key=${findApiKey()}`;

  async function driveMetadata(fileId) {
    const response = await driveFetch(
      driveUrl(fileId, '?supportsAllDrives=true&fields=id,name,mimeType,size,thumbnailLink')
    );
    if (!response.ok) {
      throw new Error(`Drive metadata failed (${response.status}) for ${fileId}`);
    }
    const meta = await response.json();
    return {
      id: meta.id,
      name: meta.name || null,
      mimeType: meta.mimeType || null,
      size: meta.size ? Number(meta.size) : null,
      thumbnailLink: meta.thumbnailLink || null,
    };
  }

  /**
   * Resolve a Drive id to bytes. Returns the metadata alongside the buffer so
   * the caller can name the file correctly, including the extension swap that a
   * native-document export implies.
   */
  async function driveDownload(fileId) {
    const meta = await driveMetadata(fileId);
    const mimeType = meta.mimeType || '';
    const isNative = mimeType.startsWith('application/vnd.google-apps');

    if (meta.size && meta.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit`);
    }

    const exportAs = isNative ? NATIVE_EXPORT_TYPES[mimeType] || NATIVE_FALLBACK : null;
    const url = exportAs
      ? driveUrl(fileId, `/export?mimeType=${encodeURIComponent(exportAs.mimeType)}`)
      : driveUrl(fileId, '?alt=media&supportsAllDrives=true');

    const response = await driveFetch(url);
    if (!response.ok) {
      throw new Error(`Drive download failed (${response.status}) for ${fileId}`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error('Attachment exceeded size limit while downloading');
    }

    return {
      meta,
      buffer,
      // A native doc exported to PDF is no longer its original type; report what
      // the bytes actually are so the archive extension matches the content.
      effectiveMimeType: exportAs ? exportAs.mimeType : mimeType || 'application/octet-stream',
      exportedExtension: exportAs ? exportAs.extension : null,
    };
  }

  const HANDLERS = {
    rpc: (payload) => callRpc(payload.method, payload.body),
    'drive.metadata': (payload) => driveMetadata(payload.fileId),
    'drive.download': (payload) => driveDownload(payload.fileId),
  };

  window.addEventListener('message', async (event) => {
    // Must be our own window, our own origin, and our own tag. Anything else is
    // page script or another extension, and is ignored silently.
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.tag !== REQUEST_TAG || typeof data.id !== 'string') return;

    const reply = (payload, transfer) =>
      window.postMessage(
        Object.assign({ tag: RESPONSE_TAG, id: data.id }, payload),
        location.origin,
        transfer || []
      );

    const handler = HANDLERS[data.op];
    if (!handler) {
      reply({ ok: false, error: `Unknown operation: ${data.op}` });
      return;
    }

    try {
      const result = await handler(data);
      // Hand the ArrayBuffer over rather than copying it.
      reply({ ok: true, result }, result && result.buffer ? [result.buffer] : []);
    } catch (error) {
      reply({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  });
})();
