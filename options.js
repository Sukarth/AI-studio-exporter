/**
 * Options page controller.
 *
 * Backup scheduling lives in the service worker because only it can reach
 * chrome.alarms reliably, so those controls talk to it by message.
 *
 * @license MIT
 */

// Every boolean setting is rendered as a checkbox of the same id, so the
// bindings are derived rather than listed twice.
const CHECKBOX_SETTINGS = Object.keys(AI_STUDIO_DEFAULT_SETTINGS).filter(
  (key) => typeof AI_STUDIO_DEFAULT_SETTINGS[key] === 'boolean'
);

const el = (id) => document.getElementById(id);

let isPro = false;

// --- helpers -------------------------------------------------------------

function toast(text) {
  const node = el('toast');
  node.textContent = text;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2600);
}

function notice(id, type, text) {
  const node = el(id);
  node.className = `notice ${type}`;
  node.textContent = text;
}

function fillFormatSelect(select, selected) {
  select.textContent = '';
  for (const format of AI_STUDIO_FORMATS) {
    const option = document.createElement('option');
    option.value = format.id;
    option.disabled = format.pro && !isPro;
    option.textContent = format.pro && !isPro ? `${format.label} — Pro` : format.label;
    select.appendChild(option);
  }
  select.value = selected;
  if (select.selectedIndex === -1 || select.options[select.selectedIndex].disabled) {
    select.value = 'markdown';
  }
}

function syncAttachmentSubOptions() {
  const enabled = el('scrapeAttachments').checked;
  const block = el('attachmentOptions');
  block.style.opacity = enabled ? '1' : '.5';
  block.style.pointerEvents = enabled ? 'auto' : 'none';
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
    fillFormatSelect(el('defaultFormat'), settings.defaultFormat);
    syncAttachmentSubOptions();
  });
}

function saveSettings() {
  const raw = { loadDelay: el('loadDelay').value, defaultFormat: el('defaultFormat').value };
  for (const key of CHECKBOX_SETTINGS) {
    if (el(key)) raw[key] = el(key).checked;
  }
  chrome.storage.sync.set(sanitizeSettings(raw), () => toast('Settings saved'));
}

function resetSettings() {
  if (!confirm('Reset all settings to their defaults?')) return;
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
  badge.className = isPro ? 'badge ok' : 'badge';

  el('deactivateBtn').hidden = !isPro;
  el('activateBtn').disabled = isPro;
  el('licenseKey').disabled = isPro;
  el('licenseKey').value = isPro ? status.key : '';

  el('backupControls').classList.toggle('locked', !isPro);

  if (isPro) {
    notice('licenseNotice', 'success', 'Pro is active on this browser. Thank you for supporting the project.');
  } else {
    el('licenseNotice').className = 'notice';
  }

  // Format pickers gain or lose their Pro entries with the licence.
  fillFormatSelect(el('defaultFormat'), el('defaultFormat').value || 'markdown');
  fillFormatSelect(el('backupFormat'), el('backupFormat').value || 'markdown');
}

async function activate() {
  const key = el('licenseKey').value.trim();
  if (!key) {
    notice('licenseNotice', 'error', 'Paste the licence key from your purchase email.');
    return;
  }

  el('activateBtn').disabled = true;
  notice('licenseNotice', 'info', 'Checking with Polar…');

  const result = await AISE.license.activate(key);
  if (result.ok) {
    await refreshLicenseUI();
    toast('Pro unlocked');
  } else {
    notice('licenseNotice', 'error', result.message);
    el('activateBtn').disabled = false;
  }
}

async function deactivate() {
  if (!confirm('Remove the licence from this browser? You can activate it again later.')) return;
  await AISE.license.deactivate();
  await refreshLicenseUI();
  toast('Licence removed');
}

// --- scheduled backup ----------------------------------------------------

const sendToWorker = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || {})));

function describeBackupState(state) {
  if (!state.lastRunAt) return 'Has not run yet.';
  const when = new Date(state.lastRunAt).toLocaleString();
  return `Last run ${when} — ${state.lastResult || 'no details'}`;
}

async function loadBackupState() {
  const { state } = await sendToWorker({ action: 'backup:state' });
  if (!state) return;

  el('backupEnabled').checked = !!state.enabled;
  el('backupFrequency').value = state.frequency || 'weekly';
  fillFormatSelect(el('backupFormat'), state.formatId || 'markdown');

  if (state.lastRunAt) notice('backupNotice', 'info', describeBackupState(state));
}

async function saveBackupState() {
  if (!isPro) return;
  const { state } = await sendToWorker({
    action: 'backup:configure',
    patch: {
      enabled: el('backupEnabled').checked,
      frequency: el('backupFrequency').value,
      formatId: el('backupFormat').value,
    },
  });
  if (state) {
    notice(
      'backupNotice',
      'info',
      state.enabled ? `Scheduled ${state.frequency}. ${describeBackupState(state)}` : 'Scheduled backup is off.'
    );
  }
}

async function runBackupNow() {
  el('runBackupBtn').disabled = true;
  notice('backupNotice', 'info', 'Running a backup now — this opens AI Studio in the background.');

  const result = await sendToWorker({ action: 'backup:runNow' });
  notice(
    'backupNotice',
    result && result.success ? 'success' : 'error',
    (result && result.message) || 'Backup failed.'
  );
  el('runBackupBtn').disabled = false;
}

// --- boot ----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  el('version').textContent = chrome.runtime.getManifest().version;

  el('saveBtn').addEventListener('click', saveSettings);
  el('resetBtn').addEventListener('click', resetSettings);
  el('scrapeAttachments').addEventListener('change', syncAttachmentSubOptions);

  el('activateBtn').addEventListener('click', activate);
  el('deactivateBtn').addEventListener('click', deactivate);
  el('buyBtn').addEventListener('click', () => chrome.tabs.create({ url: AI_STUDIO_PRO.purchaseUrl }));

  el('backupEnabled').addEventListener('change', saveBackupState);
  el('backupFrequency').addEventListener('change', saveBackupState);
  el('backupFormat').addEventListener('change', saveBackupState);
  el('runBackupBtn').addEventListener('click', runBackupNow);

  loadSettings();
  await refreshLicenseUI();
  await loadBackupState();
});
