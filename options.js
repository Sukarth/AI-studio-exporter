/**
 * Options page controller.
 *
 * Backup scheduling lives in the service worker because only it can reach
 * chrome.alarms reliably, so those controls talk to it by message.
 *
 * @license MIT
 */

// Every boolean setting is rendered as a switch of the same id, so the
// bindings are derived rather than listed twice.
const CHECKBOX_SETTINGS = Object.keys(AI_STUDIO_DEFAULT_SETTINGS).filter(
  (key) => typeof AI_STUDIO_DEFAULT_SETTINGS[key] === 'boolean'
);

const el = (id) => document.getElementById(id);

let isPro = false;

// --- helpers -------------------------------------------------------------

let toastTimer = null;

function toast(text) {
  el('toastText').textContent = text;
  el('toast').classList.add('is-shown');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el('toast').classList.remove('is-shown'), 2600);
}

/**
 * The same notice as the popup: a tone, an uppercase label and a sentence.
 * @param {?('ok'|'warn'|'err'|'info')} tone - null for the neutral slate
 */
function notice(id, tone, label, body) {
  const node = el(id);
  node.className = `notice${tone ? ` is-${tone}` : ''}`;
  node.hidden = false;
  const labelNode = node.querySelector('.notice-label');
  labelNode.textContent = label || '';
  labelNode.hidden = !label;
  node.querySelector('.notice-body').textContent = body || '';
}

const clearNotice = (id) => { el(id).hidden = true; };

/**
 * A confirm dialog that matches the rest of the extension.
 *
 * window.confirm renders the browser's own chrome, which on a settings page
 * that has just been restyled is the one thing on screen that is not ours.
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    el('resetTitle').textContent = title;
    el('resetTitle').nextElementSibling.textContent = body;
    el('resetConfirm').textContent = confirmLabel;
    el('resetScrim').hidden = false;
    el('resetCancel').focus();

    const finish = (answer) => {
      el('resetScrim').hidden = true;
      el('resetConfirm').onclick = null;
      el('resetCancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(false);
    };

    el('resetConfirm').onclick = () => finish(true);
    el('resetCancel').onclick = () => finish(false);
    document.addEventListener('keydown', onKey);
  });
}

// --- dropdowns -----------------------------------------------------------
//
// The same listbox the popup uses, for the same reason: a native <select>
// cannot show that an option is locked behind Pro, and once one dropdown on
// the page is custom the rest have to be too.

const pickers = {
  format: AISE.listbox.create(el('defaultFormat'), {
    label: 'Default export format',
    caret: 'i-caret',
  }),
  backupFrequency: AISE.listbox.create(el('backupFrequency'), {
    label: 'Backup frequency',
    caret: 'i-caret',
    onPick: () => saveBackupState(),
  }),
  backupFormat: AISE.listbox.create(el('backupFormat'), {
    label: 'Backup format',
    caret: 'i-caret',
    onPick: () => saveBackupState(),
  }),
};

pickers.backupFrequency.setOptions(
  [
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
  ],
  'weekly'
);

/**
 * Pro formats stay listed, chipped and unselectable rather than hidden:
 * hiding them means nobody discovers what Pro buys.
 */
function fillFormatPicker(picker, selected) {
  picker.setOptions(
    AI_STUDIO_FORMATS.map((format) => ({
      value: format.id,
      label: format.label,
      chip: format.pro && !isPro ? 'PRO' : null,
      disabled: format.pro && !isPro,
    })),
    selected
  );
  // setOptions drops a value the licence no longer allows, so this only has to
  // cover that one case.
  if (!picker.value) picker.setValue('markdown');
}

/** The checked radio in the theme group, or the default. */
const currentTheme = () => {
  const checked = document.querySelector('input[name="theme"]:checked');
  return checked ? checked.value : 'system';
};

/**
 * Theme applies the moment it is clicked, not on Save.
 *
 * Everything else on this page describes a future export, so waiting for Save
 * is right. Appearance is the one setting whose result is on screen already;
 * making it wait would mean choosing a theme you cannot see.
 */
function applyTheme(pref) {
  if (window.AISE_THEME) window.AISE_THEME.set(pref);
  chrome.storage.sync.set({ theme: pref });
}

function syncAttachmentSubOptions() {
  const enabled = el('scrapeAttachments').checked;
  const block = el('attachmentOptions');
  block.classList.toggle('is-off', !enabled);
  block.querySelectorAll('input').forEach((input) => { input.disabled = !enabled; });
}

// --- settings ------------------------------------------------------------

function loadSettings() {
  chrome.storage.sync.get(AI_STUDIO_DEFAULT_SETTINGS, (stored) => {
    const settings = sanitizeSettings(stored);
    for (const key of CHECKBOX_SETTINGS) {
      if (el(key)) el(key).checked = settings[key];
    }
    el('loadDelay').value = settings.loadDelay;
    fillFormatPicker(pickers.format, settings.defaultFormat);
    const radio = document.querySelector(`input[name="theme"][value="${settings.theme}"]`);
    if (radio) radio.checked = true;
    // theme-init.js painted from the local cache; storage.sync is the truth.
    if (window.AISE_THEME) window.AISE_THEME.set(settings.theme);
    syncAttachmentSubOptions();
  });
}

function saveSettings() {
  const raw = {
    loadDelay: el('loadDelay').value,
    defaultFormat: pickers.format.value,
    theme: currentTheme(),
  };
  for (const key of CHECKBOX_SETTINGS) {
    if (el(key)) raw[key] = el(key).checked;
  }
  chrome.storage.sync.set(sanitizeSettings(raw), () => toast('Settings saved'));
}

async function resetSettings() {
  const confirmed = await confirmDialog({
    title: 'Reset all settings?',
    body:
      'Format, attachments, the fine-tuning options and the backup schedule go back to ' +
      'defaults. Your licence key is kept.',
    confirmLabel: 'Reset',
  });
  if (!confirmed) return;
  chrome.storage.sync.set(AI_STUDIO_DEFAULT_SETTINGS, () => {
    loadSettings();
    toast('Settings reset');
  });
}

// --- licence -------------------------------------------------------------

async function refreshLicenseUI() {
  const status = await AISE.license.status();
  isPro = status.pro;

  const badge = el('proBadge');
  badge.textContent = isPro ? 'ACTIVE' : 'LOCKED';
  badge.className = isPro ? 'chip chip-ok' : 'chip';

  // Activating swaps the whole panel rather than disabling the field: an
  // input you cannot type in, holding a key you cannot read, is furniture.
  el('licenseEntry').hidden = isPro;
  el('licenseActive').hidden = !isPro;
  el('licenseBlurb').hidden = isPro;
  el('buyBtn').parentElement.hidden = isPro;
  el('licenseMasked').textContent = isPro ? status.key : '';
  el('licenseKey').value = isPro ? status.key : '';
  el('tierLabel').hidden = !isPro;

  el('backupPanel').classList.toggle('is-locked', !isPro);
  el('backupControls').classList.toggle('locked', !isPro);
  el('backupProBadge').hidden = isPro;
  for (const control of ['backupEnabled', 'runBackupBtn']) {
    el(control).disabled = !isPro;
  }
  pickers.backupFrequency.disabled = !isPro;
  pickers.backupFormat.disabled = !isPro;

  if (isPro) clearNotice('licenseNotice');

  // Format pickers gain or lose their Pro entries with the licence.
  fillFormatPicker(pickers.format, pickers.format.value || 'markdown');
  fillFormatPicker(pickers.backupFormat, pickers.backupFormat.value || 'markdown');
}

async function activate() {
  const key = el('licenseKey').value.trim();
  if (!key) {
    notice('licenseNotice', 'err', 'Not activated', 'Paste the licence key from your purchase email.');
    el('licenseKey').classList.add('is-invalid');
    return;
  }

  el('licenseKey').classList.remove('is-invalid');
  el('activateBtn').disabled = true;
  notice('licenseNotice', 'info', null, 'Checking with Polar…');

  const result = await AISE.license.activate(key);
  if (result.ok) {
    await refreshLicenseUI();
    el('activateBtn').disabled = false;
    toast('Pro unlocked');
  } else {
    notice('licenseNotice', 'err', 'Not activated', result.message);
    el('licenseKey').classList.add('is-invalid');
    el('activateBtn').disabled = false;
  }
}

async function deactivate() {
  const confirmed = await confirmDialog({
    title: 'Remove the licence?',
    body: 'Pro locks on this browser. You can activate the same key again later.',
    confirmLabel: 'Remove',
  });
  if (!confirmed) return;

  const result = await AISE.license.deactivate();
  await refreshLicenseUI();
  // The message differs when Polar could not be told, and that difference is
  // the whole point of showing it: an unreleased slot counts against the limit.
  notice('licenseNotice', null, 'Licence removed', result.message);
  toast('Licence removed');
}

// --- scheduled backup ----------------------------------------------------

const sendToWorker = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || {})));

const whenRun = (at) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

/** Grade a backup result the same way the toolbar badge grades an export. */
function backupTone(state) {
  const result = state.lastResult || '';
  if (/^Failed:/.test(result)) return { tone: 'err', label: 'Last backup failed' };
  if (/failed|unavailable|reduced fidelity/i.test(result)) return { tone: 'warn', label: 'Last backup, check this' };
  return { tone: 'ok', label: 'Last backup' };
}

async function loadBackupState() {
  const { state } = await sendToWorker({ action: 'backup:state' });
  if (!state) return;

  el('backupEnabled').checked = !!state.enabled;
  pickers.backupFrequency.setValue(state.frequency || 'weekly');
  fillFormatPicker(pickers.backupFormat, state.formatId || 'markdown');

  if (state.lastRunAt) {
    const { tone, label } = backupTone(state);
    notice('backupNotice', tone, label, `${whenRun(state.lastRunAt)} · ${state.lastResult || 'no details'}`);
  }
}

async function saveBackupState() {
  if (!isPro) return;
  const { state } = await sendToWorker({
    action: 'backup:configure',
    patch: {
      enabled: el('backupEnabled').checked,
      frequency: pickers.backupFrequency.value,
      formatId: pickers.backupFormat.value,
    },
  });
  if (!state) return;

  if (!state.enabled) {
    notice('backupNotice', null, 'Scheduled backup', 'Off.');
  } else if (state.lastRunAt) {
    const { tone, label } = backupTone(state);
    notice('backupNotice', tone, label, `${whenRun(state.lastRunAt)} · ${state.lastResult || 'no details'}`);
  } else {
    notice('backupNotice', null, 'Scheduled backup', `Set to ${state.frequency}. Has not run yet.`);
  }
}

async function runBackupNow() {
  el('runBackupBtn').disabled = true;
  notice('backupNotice', 'info', null, 'Running a backup now. This opens AI Studio in the background.');

  const result = await sendToWorker({ action: 'backup:runNow' });
  notice(
    'backupNotice',
    result && result.success ? 'ok' : 'err',
    result && result.success ? 'Backup finished' : 'Backup failed',
    (result && result.message) || 'No details.'
  );
  el('runBackupBtn').disabled = false;
}

// --- boot ----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  el('version').textContent = chrome.runtime.getManifest().version;

  el('saveBtn').addEventListener('click', saveSettings);
  el('resetBtn').addEventListener('click', resetSettings);
  el('scrapeAttachments').addEventListener('change', syncAttachmentSubOptions);
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.addEventListener('change', () => applyTheme(radio.value));
  }

  el('activateBtn').addEventListener('click', activate);
  el('deactivateBtn').addEventListener('click', deactivate);
  el('buyBtn').addEventListener('click', () => chrome.tabs.create({ url: AI_STUDIO_PRO.purchaseUrl }));

  el('backupEnabled').addEventListener('change', saveBackupState);
  el('runBackupBtn').addEventListener('click', runBackupNow);

  loadSettings();
  await refreshLicenseUI();
  await loadBackupState();
});
