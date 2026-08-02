/**
 * Popup controller.
 *
 * Sends work to the content script rather than doing it here: the popup closes
 * the moment it loses focus, which would abort anything running in it. That
 * also means the popup never sees the result of an export it started, so the
 * two things it does show are read back from elsewhere: live progress polled
 * from the content script, and the last outcome stored by the badge.
 *
 * @license MIT
 */

document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);

  const el = {
    blocked: $('blocked'),
    blockedIcon: $('blockedIcon'),
    blockedTitle: $('blockedTitle'),
    blockedBody: $('blockedBody'),
    progress: $('progress'),
    progressStage: $('progressStage'),
    progressCount: $('progressCount'),
    progressBar: $('progressBar'),
    exportBtn: $('exportBtn'),
    btnText: $('btnText'),
    libraryBtn: $('exportLibraryBtn'),
    libraryProBadge: $('libraryProBadge'),
    message: $('message'),
    messageLabel: $('messageLabel'),
    messageBody: $('messageBody'),
    messageAction: $('messageAction'),
    messageActionText: $('messageActionText'),
    settingsBtn: $('settingsBtn'),
    version: $('versionLabel'),
    upgrade: $('upgradeLink'),
    tier: $('tierLabel'),
  };

  let isPro = false;
  let onPromptPage = false;
  let exporting = false;
  let lastProgress = null;
  let pollTimer = null;

  // --- notices ------------------------------------------------------------

  /**
   * One notice pattern, four tones, optionally with an action.
   * @param {?('ok'|'warn'|'err'|'info')} tone - null for the neutral slate
   */
  function showMessage(tone, label, body, action) {
    el.message.className = `notice${tone ? ` is-${tone}` : ''}`;
    el.message.hidden = false;
    el.messageLabel.textContent = label || '';
    el.messageLabel.hidden = !label;
    el.messageBody.textContent = body || '';
    el.messageAction.hidden = !action;
    if (action) {
      el.messageActionText.textContent = action.label;
      el.messageAction.onclick = action.run;
    }
  }

  const hideMessage = () => { el.message.hidden = true; };

  function showBlocked(tone, icon, title, body) {
    el.blocked.className = `notice has-icon is-${tone}`;
    el.blocked.hidden = false;
    el.blockedIcon.setAttribute('href', icon);
    el.blockedTitle.textContent = title;
    el.blockedBody.textContent = body;
  }

  const hideBlocked = () => { el.blocked.hidden = true; };

  // --- format picker ------------------------------------------------------

  /**
   * Pro formats stay listed, chipped and unselectable rather than hidden:
   * hiding them means nobody discovers what Pro buys.
   */
  const formatEntries = () =>
    AI_STUDIO_FORMATS.map((format) => ({
      value: format.id,
      label: format.label,
      chip: format.pro && !isPro ? 'PRO' : null,
      disabled: format.pro && !isPro,
    }));

  const picker = AISE.listbox.create($('formatPicker'), {
    label: 'Export format',
    caret: 'i-caret',
    onPick: (id) => chrome.storage.sync.set({ defaultFormat: id }),
  });

  // --- state --------------------------------------------------------------

  el.version.textContent = `v${chrome.runtime.getManifest().version}`;

  el.settingsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL('options.html'));
  });

  el.upgrade.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: AI_STUDIO_PRO.purchaseUrl });
  });

  /** Paint the progress panel from whatever the content script last reported. */
  function renderProgress(progress) {
    lastProgress = progress || null;
    if (!progress) {
      el.progress.hidden = true;
      return;
    }
    el.progress.hidden = false;
    el.progress.className = `progress${progress.tone === 'warn' ? ' is-warn' : ''}`;
    el.progressStage.textContent = progress.stage || 'Export in progress';
    el.progressCount.textContent = progress.total ? `${progress.done} / ${progress.total}` : '';

    const fill = el.progressBar.firstElementChild;
    if (progress.total) {
      el.progressBar.className = `bar${progress.tone === 'warn' ? ' is-warn' : ''}`;
      fill.style.width = `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`;
    } else {
      el.progressBar.className = 'bar is-indeterminate';
      fill.style.width = '';
    }
  }

  function setExporting(active, progress) {
    exporting = active;
    picker.disabled = active;
    renderProgress(active ? progress || lastProgress || {} : null);

    el.exportBtn.disabled = active ? false : !onPromptPage;
    el.exportBtn.className = active ? 'btn btn-danger' : 'btn btn-primary';
    el.btnText.textContent = active ? 'Stop export' : 'Export this conversation';
    el.libraryBtn.disabled = active || !isPro;
  }

  /** While an export runs, the popup is the only live view of it. */
  function startPolling(tabId) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const status = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
        if (!status || !status.isExporting) {
          clearInterval(pollTimer);
          pollTimer = null;
          setExporting(false);
          await showLastRun();
          return;
        }
        renderProgress(status.progress);
      } catch (_) {
        clearInterval(pollTimer);
        pollTimer = null;
        setExporting(false);
      }
    }, 500);
  }

  async function refresh() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onAIStudio = tab && isAIStudioUrl(tab.url);
    onPromptPage = !!(tab && isAIStudioPromptUrl(tab.url));

    if (!onAIStudio) {
      showBlocked('err', '#i-alert', 'Not on AI Studio', 'Open aistudio.google.com to export.');
      setExporting(false);
      el.exportBtn.disabled = true;
      el.libraryBtn.disabled = true;
      return;
    }

    if (!onPromptPage) {
      showBlocked('warn', '#i-clock', 'No conversation open', 'Open one, then reopen this popup.');
    } else {
      hideBlocked();
    }

    try {
      const status = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      if (status && status.isExporting) {
        hideBlocked();
        setExporting(true, status.progress);
        startPolling(tab.id);
        return;
      }
    } catch (_) {
      // Content script not injected yet; the page probably needs a reload.
    }
    setExporting(false);
  }

  /**
   * Report on the export that ran while the popup was closed.
   *
   * Opening the popup is also the acknowledgement that clears a sticky badge,
   * so this runs on every open, not only when there is something to say.
   */
  async function showLastRun() {
    let status = null;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'status:seen' });
      status = response && response.status;
    } catch (_) {
      return;
    }
    if (!status || !status.text || status.state === 'idle') return;
    if (status.state === 'running' || status.state === 'reading') return;

    // A downgrade is red on the toolbar because you asked for one thing and
    // got another, but here there is room to be precise: a file was produced,
    // so the notice is amber and carries the way out.
    if (status.kind === 'downgrade') {
      showMessage('warn', 'Exported in the wrong format', status.text, {
        label: 'Unlock Pro',
        run: () => chrome.tabs.create({ url: AI_STUDIO_PRO.purchaseUrl }),
      });
      return;
    }

    const label = {
      done: 'Last export',
      partial: 'Last export, check this',
      failed: 'Last export failed',
    }[status.state];
    const tone = { done: 'ok', partial: 'warn', failed: 'err' }[status.state];
    showMessage(tone, label, status.text);
  }

  // --- actions ------------------------------------------------------------

  async function withTab(fn) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isAIStudioUrl(tab.url)) {
      showMessage('err', null, 'Open aistudio.google.com first.');
      return;
    }
    try {
      await fn(tab);
    } catch (error) {
      setExporting(false);
      const message = error && error.message ? error.message : String(error);
      if (/Could not establish connection|Receiving end does not exist/.test(message)) {
        showMessage('err', null, 'Reload the AI Studio page, then try again.', {
          label: 'Reload the tab',
          run: () => { chrome.tabs.reload(tab.id); window.close(); },
        });
      } else {
        showMessage('err', null, message);
      }
    }
  }

  el.exportBtn.addEventListener('click', () =>
    withTab(async (tab) => {
      if (exporting) {
        await chrome.tabs.sendMessage(tab.id, { action: 'cancel' });
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        const at = lastProgress && lastProgress.total
          ? `Cancelled at ${lastProgress.done} of ${lastProgress.total}. Nothing was saved.`
          : 'Cancelled. Nothing was saved.';
        setExporting(false);
        showMessage(null, 'Last export', at);
        return;
      }
      if (!onPromptPage) {
        showMessage('err', null, 'Open a conversation first.');
        return;
      }

      hideMessage();
      chrome.tabs.sendMessage(tab.id, { action: 'export', formatId: picker.value });
      // The overlay in the page reports progress from here; this window would
      // be destroyed the moment it loses focus anyway.
      window.close();
    })
  );

  el.libraryBtn.addEventListener('click', () =>
    withTab(async (tab) => {
      if (!isPro) {
        showMessage('info', null, 'Library export is a Pro feature.', {
          label: 'Upgrade now',
          run: () => chrome.tabs.create({ url: AI_STUDIO_PRO.purchaseUrl }),
        });
        return;
      }
      hideMessage();
      chrome.tabs.sendMessage(tab.id, { action: 'exportLibrary', formatId: picker.value });
      window.close();
    })
  );

  // --- boot ---------------------------------------------------------------

  isPro = await AISE.license.isPro({ skipRevalidation: true });
  el.libraryProBadge.hidden = isPro;
  el.upgrade.hidden = isPro;
  el.tier.hidden = !isPro;

  const stored = await new Promise((resolve) =>
    chrome.storage.sync.get(AI_STUDIO_DEFAULT_SETTINGS, (s) => resolve(sanitizeSettings(s)))
  );
  // theme-init.js already painted from the local cache, which is empty on a
  // browser this profile has only just synced to. Correcting it here is a
  // no-op in the common case and the difference between right and wrong once.
  if (window.AISE_THEME) window.AISE_THEME.set(stored.theme);
  // setOptions drops a stored format the licence no longer allows, so the
  // fallback below only has to cover that one case.
  picker.setOptions(formatEntries(), stored.defaultFormat);
  if (!picker.value) picker.setValue('markdown');

  await refresh();
  if (!exporting) await showLastRun();
});
