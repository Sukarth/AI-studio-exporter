/**
 * Popup controller.
 *
 * Sends work to the content script rather than doing it here: the popup closes
 * the moment it loses focus, which would abort anything running in it.
 *
 * @license MIT
 */

const PURCHASE_URL = 'https://github.com/Sukarth/AI-studio-exporter#pro';

document.addEventListener('DOMContentLoaded', async () => {
  const el = {
    status: document.getElementById('status'),
    statusText: document.getElementById('statusText'),
    statusIcon: document.querySelector('.status-icon'),
    format: document.getElementById('formatSelect'),
    exportBtn: document.getElementById('exportBtn'),
    btnText: document.getElementById('btnText'),
    libraryBtn: document.getElementById('exportLibraryBtn'),
    libraryProBadge: document.getElementById('libraryProBadge'),
    message: document.getElementById('message'),
    settingsBtn: document.getElementById('settingsBtn'),
    version: document.getElementById('versionLabel'),
    upgrade: document.getElementById('upgradeLink'),
  };

  let isPro = false;
  let onPromptPage = false;

  const showMessage = (type, text) => {
    el.message.className = `message ${type}`;
    el.message.textContent = text;
  };

  el.version.textContent = `v${chrome.runtime.getManifest().version}`;

  el.settingsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL('options.html'));
  });

  el.upgrade.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: PURCHASE_URL });
  });

  // --- format picker ----------------------------------------------------

  function renderFormats(selected) {
    el.format.textContent = '';
    for (const format of AI_STUDIO_FORMATS) {
      const option = document.createElement('option');
      option.value = format.id;
      // Locked formats stay visible but unselectable: hiding them entirely
      // means nobody discovers what Pro actually buys.
      option.disabled = format.pro && !isPro;
      option.textContent = format.pro && !isPro ? `${format.label} — Pro` : format.label;
      el.format.appendChild(option);
    }
    el.format.value = selected;
    if (el.format.selectedIndex === -1 || el.format.options[el.format.selectedIndex].disabled) {
      el.format.value = 'markdown';
    }
  }

  el.format.addEventListener('change', () => {
    chrome.storage.sync.set({ defaultFormat: el.format.value });
  });

  // --- state ------------------------------------------------------------

  const setStatus = (active, text, icon) => {
    el.status.className = active ? 'status active' : 'status inactive';
    el.statusText.textContent = text;
    el.statusIcon.textContent = icon;
  };

  const setBusy = (busy, exporting) => {
    if (busy && exporting) {
      el.exportBtn.classList.add('stop-mode');
      el.exportBtn.disabled = false;
      el.btnText.textContent = 'Stop Export';
      el.libraryBtn.disabled = true;
      return;
    }
    el.exportBtn.classList.remove('stop-mode');
    el.exportBtn.disabled = busy || !onPromptPage;
    el.btnText.innerHTML = busy
      ? '<span class="spinner"></span> Starting…'
      : 'Export Conversation';
    el.libraryBtn.disabled = busy || !isPro;
  };

  async function refresh() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onAIStudio = tab && isAIStudioUrl(tab.url);
    onPromptPage = tab && isAIStudioPromptUrl(tab.url);

    if (!onAIStudio) {
      setStatus(false, 'Open aistudio.google.com to export', '⚠');
      setBusy(false);
      el.exportBtn.disabled = true;
      el.libraryBtn.disabled = true;
      return;
    }

    if (!onPromptPage) {
      setStatus(true, 'Open a conversation to export it', 'ℹ');
    } else {
      setStatus(true, 'Connected to AI Studio', '✓');
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      if (response && response.isExporting) {
        setStatus(true, 'Export in progress…', '⏳');
        setBusy(true, true);
        return;
      }
    } catch (_) {
      // Content script not injected yet; the page probably needs a reload.
    }
    setBusy(false);
  }

  // --- actions ----------------------------------------------------------

  async function withTab(fn) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isAIStudioUrl(tab.url)) {
      showMessage('error', 'Open aistudio.google.com first.');
      return;
    }
    try {
      await fn(tab);
    } catch (error) {
      setBusy(false);
      const message = error && error.message ? error.message : String(error);
      showMessage(
        'error',
        /Could not establish connection|Receiving end does not exist/.test(message)
          ? 'Reload the AI Studio page, then try again.'
          : message
      );
    }
  }

  el.exportBtn.addEventListener('click', () =>
    withTab(async (tab) => {
      if (el.exportBtn.classList.contains('stop-mode')) {
        await chrome.tabs.sendMessage(tab.id, { action: 'cancel' });
        setBusy(false);
        setStatus(true, 'Export cancelled', '✓');
        return;
      }
      if (!onPromptPage) {
        showMessage('error', 'Open a conversation first.');
        return;
      }

      setBusy(true);
      el.message.className = 'message';
      chrome.tabs.sendMessage(tab.id, { action: 'export', formatId: el.format.value });
      // The overlay in the page reports progress from here; the popup would be
      // destroyed the moment it loses focus.
      window.close();
    })
  );

  el.libraryBtn.addEventListener('click', () =>
    withTab(async (tab) => {
      if (!isPro) {
        showMessage('info', 'Library export is a Pro feature.');
        return;
      }
      setBusy(true);
      el.message.className = 'message';
      chrome.tabs.sendMessage(tab.id, { action: 'exportLibrary', formatId: el.format.value });
      window.close();
    })
  );

  // --- boot -------------------------------------------------------------

  isPro = await AISE.license.isPro({ skipRevalidation: true });
  el.libraryProBadge.hidden = isPro;
  el.upgrade.hidden = isPro;

  const stored = await new Promise((resolve) =>
    chrome.storage.sync.get(AI_STUDIO_DEFAULT_SETTINGS, (s) => resolve(sanitizeSettings(s)))
  );
  renderFormats(stored.defaultFormat);

  await refresh();
});
