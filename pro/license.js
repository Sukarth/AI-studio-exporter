/**
 * Pro licence handling, backed by Polar.
 *
 * Deliberate design limits, stated plainly because the code is public:
 *
 *  - Keys cannot be forged. Validation happens against Polar, which is the
 *    source of truth, so nobody can mint a working key offline.
 *  - The check *can* be bypassed. This is client-side JavaScript in an
 *    open-source extension; anyone can edit it out. No obfuscation is
 *    attempted, because none would work and it would only hurt auditability.
 *
 * The network is touched once, at activation. After that the licence lives in
 * local storage and Pro features work offline forever, which keeps the
 * privacy promise that nothing about a user's conversations leaves the machine.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const API = 'https://api.polar.sh/v1/customer-portal/license-keys';
  const STORAGE_KEY = 'proLicense';

  // Re-validation is a courtesy, not a gate: it lets a refunded or revoked key
  // eventually stop working without ever blocking an offline user.
  const REVALIDATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

  const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

  // settings.js is always loaded first, in every context that loads this file.
  // Read at call time rather than at load, so the guard below is what reports a
  // missing configuration instead of a ReferenceError at startup.
  const organizationId = () =>
    (typeof AI_STUDIO_PRO !== 'undefined' && AI_STUDIO_PRO.polarOrganizationId) || '';

  function readStored() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [STORAGE_KEY]: null }, (data) => resolve(data[STORAGE_KEY] || null));
    });
  }

  function writeStored(value) {
    return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: value }, resolve));
  }

  /**
   * Ask Polar to validate, and activate the key against this browser so the
   * seat count is enforced server-side rather than on the honour system.
   */
  async function callPolar(path, body) {
    const response = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { /* non-JSON error body */ }

    if (!response.ok) {
      const detail =
        (payload && (payload.detail || payload.error || payload.message)) ||
        `HTTP ${response.status}`;
      throw new Error(typeof detail === 'string' ? detail : 'Licence check failed');
    }
    return payload;
  }

  /** A stable per-install id, so activations are counted per browser profile. */
  async function installationId() {
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get({ installationId: null }, (d) => resolve(d.installationId))
    );
    if (stored) return stored;

    const id = crypto.randomUUID();
    await new Promise((resolve) => chrome.storage.local.set({ installationId: id }, resolve));
    return id;
  }

  /**
   * Activate a licence key. Called once, from the options page.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!KEY_PATTERN.test(key)) {
      return { ok: false, message: 'That does not look like a licence key.' };
    }
    // Polar rejects a request with no organisation with an opaque error; say
    // what is actually wrong instead of blaming the key.
    if (!organizationId()) {
      return {
        ok: false,
        message: 'This build has no store configured (AI_STUDIO_PRO.polarOrganizationId in settings.js).',
      };
    }

    try {
      const result = await callPolar('activate', {
        key,
        organization_id: organizationId(),
        label: 'AI Studio Exporter',
        meta: { installation: await installationId() },
      });

      await writeStored({
        key,
        activationId: (result && result.id) || null,
        activatedAt: Date.now(),
        lastCheckedAt: Date.now(),
        valid: true,
      });

      return { ok: true, message: 'Pro unlocked. Thank you for supporting the project.' };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : 'Could not reach Polar.' };
    }
  }

  async function deactivate() {
    await writeStored(null);
    return { ok: true, message: 'Licence removed from this browser.' };
  }

  /**
   * Whether Pro features should be available.
   *
   * A stored licence stays trusted when offline or when Polar is unreachable —
   * a paying user must never lose access because their network is down. Only an
   * explicit rejection from Polar clears it.
   */
  async function isPro(options) {
    const stored = await readStored();
    if (!stored || !stored.valid) return false;

    const stale = Date.now() - (stored.lastCheckedAt || 0) > REVALIDATE_AFTER_MS;
    if (!stale || (options && options.skipRevalidation)) return true;

    try {
      const result = await callPolar('validate', {
        key: stored.key,
        organization_id: organizationId(),
        activation_id: stored.activationId || undefined,
      });

      const stillValid = !result || result.status === undefined || result.status === 'granted';
      await writeStored(Object.assign({}, stored, { lastCheckedAt: Date.now(), valid: stillValid }));
      return stillValid;
    } catch (_) {
      // Network failure is not evidence of an invalid licence.
      await writeStored(Object.assign({}, stored, { lastCheckedAt: Date.now() }));
      return true;
    }
  }

  async function status() {
    const stored = await readStored();
    if (!stored) return { pro: false, key: null };
    return {
      pro: !!stored.valid,
      // Never surface the whole key in UI; enough to recognise, not to copy.
      key: `${stored.key.slice(0, 4)}…${stored.key.slice(-4)}`,
      activatedAt: stored.activatedAt || null,
      lastCheckedAt: stored.lastCheckedAt || null,
    };
  }

  /**
   * Gate a format id. Returns the requested format when allowed, and falls back
   * to Markdown with an explanation when not, so an export never simply fails.
   */
  async function resolveFormat(formatId) {
    const format = AISE.formats[formatId];
    if (!format) return { format: AISE.formats.markdown, downgraded: true, reason: 'Unknown format.' };
    if (!format.pro) return { format, downgraded: false, reason: null };

    if (await isPro({ skipRevalidation: true })) {
      return { format, downgraded: false, reason: null };
    }
    return {
      format: AISE.formats.markdown,
      downgraded: true,
      reason: `${format.label} is a Pro format. Exported as Markdown instead.`,
    };
  }

  AISE.license = { activate, deactivate, isPro, status, resolveFormat, STORAGE_KEY };
})(typeof globalThis !== 'undefined' ? globalThis : self);
