/***
 * Content script for the AI Studio Exporter.
 *
 * Two responsibilities:
 *   1. The progress overlay and the message channel to the popup.
 *   2. A DOM-scraping extractor, used only when the API path fails.
 *
 * Scraping is the fallback, not the primary route. It is slow: every turn has
 * to be scrolled into view and given time to render, and it can only see what
 * the page draws, so model settings, token counts and timestamps are lost. It
 * exists because the API it replaces is undocumented and could change without
 * notice, and a degraded export beats no export.
 *
 * @author Sukarth Acharya
 * @license MIT
 * @repository https://github.com/sukarth/ai-studio-exporter
 */

(function (root) {
  'use strict';

  const AISE = (root.AISE = root.AISE || {});

  const CONFIG = { ELEMENT_LOAD_DELAY: 700 };
  const ALLOWED_ACTIONS = new Set(['export', 'exportLibrary', 'getStatus', 'cancel']);

  let isExporting = false;
  let shouldCancel = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- progress state -----------------------------------------------------

  /**
   * What the export is doing right now.
   *
   * Two things read this: the injected overlay, and the popup, which polls for
   * it so that reopening mid-export shows live progress rather than the word
   * "exporting". Keeping one record means they can never disagree.
   *
   * `tone` is 'accent' normally, 'warn' once the API path has been abandoned,
   * and 'muted' while a cancellation is settling.
   */
  let progress = null;

  const emptyProgress = () => ({
    stage: 'Starting',
    detail: '',
    done: 0,
    total: 0,
    tone: 'accent',
    note: null,
    failed: 0,
  });

  // Counts arrive inside the stage text ("Downloading attachments… (3/7)") or
  // as a detail of their own ("128 / 312"). Reading both means no call site
  // has to change to feed the progress bar.
  const COUNT = /(\d+)\s*\/\s*(\d+)/;

  function setProgress(message, detail) {
    if (!progress) progress = emptyProgress();

    const source = COUNT.exec(detail || '') || COUNT.exec(message || '');
    if (source) {
      progress.done = Number(source[1]);
      progress.total = Number(source[2]);
    }

    if (message) {
      // The count belongs on the mono line, not in the sentence.
      progress.stage = message.replace(/\s*\(?\d+\s*\/\s*\d+\)?/, '').replace(/[…:]\s*$/, '').trim();
      const failures = /\((\d+) failed\)/.exec(message);
      progress.failed = failures ? Number(failures[1]) : progress.failed;
      progress.stage = progress.stage.replace(/\s*\(\d+ failed\)/, '').trim();
    }
    if (detail && !source) progress.detail = detail;
    else if (source) progress.detail = detail && !COUNT.test(detail) ? detail : '';

    paintOverlay();
  }

  // --- progress overlay ---------------------------------------------------

  // Tokens duplicated from theme.css by necessity: this markup is injected
  // into a page we do not control, so it cannot link a stylesheet of ours.
  const OVERLAY_CSS = `
    @keyframes aise-spin { to { transform: rotate(360deg); } }
    @keyframes aise-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(333%); } }
    #aise-overlay {
      position: fixed; inset: 0; z-index: 2147483000;
      display: flex; align-items: center; justify-content: center;
      background: rgba(8,9,11,.72); backdrop-filter: blur(8px);
      font-family: Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    #aise-overlay .aise-card {
      width: 340px; padding: 26px; text-align: center;
      background: #16181c; border: 1px solid #262931; border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,.5); color: #e7e8ea;
    }
    #aise-overlay .aise-spin {
      width: 36px; height: 36px; margin: 0 auto 16px; border-radius: 50%;
      border: 3px solid rgba(79,157,250,.2); border-top-color: #4f9dfa;
      animation: aise-spin 1s linear infinite;
    }
    #aise-overlay.is-warn .aise-spin { border-color: rgba(217,163,74,.2); border-top-color: #d9a34a; }
    #aise-overlay.is-muted .aise-spin { border-color: rgba(143,148,156,.2); border-top-color: #8f949c; }
    #aise-overlay .aise-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; letter-spacing: -.01em; }
    #aise-overlay .aise-stage {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      font-size: 13px; color: #8f949c; min-height: 20px;
    }
    #aise-overlay.is-warn .aise-stage { color: #e0be86; }
    #aise-overlay .aise-failed {
      font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
      background: rgba(232,115,107,.16); color: #f0a49e;
    }
    #aise-overlay .aise-bar {
      height: 4px; border-radius: 999px; background: #26282f;
      margin: 16px 0 10px; overflow: hidden;
    }
    #aise-overlay .aise-bar > i { display: block; height: 100%; background: #4f9dfa; transition: width .25s ease; }
    #aise-overlay.is-warn .aise-bar > i { background: #d9a34a; }
    #aise-overlay.is-muted .aise-bar > i { background: #4b4f57; }
    #aise-overlay .aise-bar.is-sweep > i {
      width: 30%; background: rgba(79,157,250,.55); animation: aise-sweep 1.4s ease-in-out infinite;
    }
    #aise-overlay .aise-count {
      font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
      font-size: 11.5px; color: #6f757d; margin-bottom: 16px; min-height: 17px;
    }
    #aise-overlay.is-accent .aise-count { color: #9cc9fd; }
    #aise-overlay.is-warn .aise-count { color: #e0be86; }
    #aise-overlay .aise-note {
      margin: 14px 0 12px; padding: 9px 11px; border-radius: 9px; text-align: left;
      background: rgba(217,163,74,.1); font-size: 11.5px; line-height: 1.45; color: #cbbfa6;
    }
    #aise-overlay .aise-cancel {
      padding: 9px 18px; border-radius: 8px; font-family: inherit;
      font-size: 12.5px; font-weight: 600; cursor: pointer;
      background: rgba(232,115,107,.1); border: 1px solid rgba(232,115,107,.3); color: #e8736b;
    }
    #aise-overlay .aise-cancel:hover { background: rgba(232,115,107,.18); }
    #aise-overlay .aise-cancel:disabled {
      background: transparent; border-color: #2b2e36; color: #5c6169; cursor: not-allowed;
    }
    @media (prefers-reduced-motion: reduce) {
      #aise-overlay .aise-spin, #aise-overlay .aise-bar > i { animation: none; }
    }
  `;

  function showLoadingOverlay(heading) {
    if (document.getElementById('aise-overlay')) return;

    if (!document.getElementById('aise-overlay-style')) {
      const style = document.createElement('style');
      style.id = 'aise-overlay-style';
      style.textContent = OVERLAY_CSS;
      document.head.appendChild(style);
    }

    const title = heading || 'Exporting conversation';
    const overlay = document.createElement('div');
    overlay.id = 'aise-overlay';
    overlay.className = 'is-accent';

    // Built as nodes rather than one innerHTML string: the heading is a
    // parameter, and a template that interpolates one is a template someone
    // eventually passes user text to.
    const card = document.createElement('div');
    card.className = 'aise-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-label', title);
    card.innerHTML =
      '<div class="aise-spin"></div>' +
      '<div class="aise-title"></div>' +
      '<div class="aise-stage"><span class="aise-stage-text"></span></div>' +
      '<div class="aise-bar is-sweep"><i></i></div>' +
      '<div class="aise-count">&nbsp;</div>' +
      '<button class="aise-cancel" type="button">Cancel export</button>';
    card.querySelector('.aise-title').textContent = `${title}…`;
    overlay.appendChild(card);

    // Swallow interaction so a stray click can't disturb the page mid-export.
    for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup']) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

    card.querySelector('.aise-cancel').addEventListener('click', (event) => {
      shouldCancel = true;
      if (progress) progress.tone = 'muted';
      const button = event.currentTarget;
      button.textContent = 'Cancelling…';
      button.disabled = true;
      paintOverlay();
    });

    document.body.appendChild(overlay);
    paintOverlay();
  }

  /**
   * Draw the current progress into the overlay.
   *
   * Every element is always present and every one has a reserved height, so
   * the card is the same size at every stage. The previous version grew and
   * shrank as stages came and went.
   */
  function paintOverlay() {
    const overlay = document.getElementById('aise-overlay');
    if (!overlay || !progress) return;

    overlay.className = `is-${progress.tone}`;

    const stage = overlay.querySelector('.aise-stage');
    stage.querySelector('.aise-stage-text').textContent = progress.stage || '';

    let chip = stage.querySelector('.aise-failed');
    if (progress.failed) {
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'aise-failed';
        stage.appendChild(chip);
      }
      chip.textContent = `${progress.failed} failed`;
    } else if (chip) {
      chip.remove();
    }

    const bar = overlay.querySelector('.aise-bar');
    const fill = bar.firstElementChild;
    if (progress.total) {
      bar.className = 'aise-bar';
      fill.style.width = `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`;
    } else {
      bar.className = 'aise-bar is-sweep';
      fill.style.width = '';
    }

    const parts = [];
    if (progress.total) parts.push(`${progress.done} / ${progress.total}`);
    if (progress.detail) parts.push(progress.detail);
    const count = overlay.querySelector('.aise-count');
    count.textContent = parts.join(' · ');
    if (!parts.length) count.innerHTML = '&nbsp;';

    let note = overlay.querySelector('.aise-note');
    if (progress.note && !note) {
      note = document.createElement('div');
      note.className = 'aise-note';
      overlay.querySelector('.aise-card').insertBefore(note, overlay.querySelector('.aise-cancel'));
    }
    if (note) note.textContent = progress.note || '';
  }

  function hideLoadingOverlay() {
    const overlay = document.getElementById('aise-overlay');
    if (!overlay) return;
    overlay.style.transition = 'opacity .3s ease';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
  }

  // --- raw-mode toggle ----------------------------------------------------

  const getMoreActionsButton = () => document.querySelector('button[aria-label="View more actions"]');
  const getRawOutputToggleButton = () => document.querySelector('button[aria-label="Toggle viewing raw output"]');

  /**
   * The toggle's own label states which way it will switch, so reading it is
   * both cheaper and more reliable than the previous approach of serialising
   * document.body.innerHTML, an operation that grew with conversation length
   * and ran on every check.
   */
  function isRawModeEnabled() {
    const button = getRawOutputToggleButton();
    if (!button) return false;
    return /markdown formatting/i.test(button.textContent || '');
  }

  async function ensureMoreActionsMenuOpen() {
    const moreActions = getMoreActionsButton();
    if (!moreActions) throw new Error('Could not find the "View more actions" button');

    if (getRawOutputToggleButton()) return getRawOutputToggleButton();

    moreActions.click();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY / 5);

    const toggle = getRawOutputToggleButton();
    if (!toggle) throw new Error('Could not find the "Toggle viewing raw output" button');
    return toggle;
  }

  async function closeMoreActionsMenuIfOpen() {
    if (!getRawOutputToggleButton()) return;
    const moreActions = getMoreActionsButton();
    if (!moreActions) return;
    moreActions.click();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY / 5);
  }

  // --- media --------------------------------------------------------------

  const MIME_EXTENSIONS = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  };

  /**
   * Read an image the page has already loaded. Returns the real MIME type from
   * the blob rather than assuming JPEG, which previously caused every export to
   * save PNGs under a .jpg extension.
   */
  async function readImageElement(img, index) {
    const src = img.getAttribute('src');
    if (!src) return null;

    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const mimeType = blob.type || 'image/png';
      const alt = (img.getAttribute('alt') || '').trim();
      const extension = MIME_EXTENSIONS[mimeType] || 'png';

      return {
        type: 'image',
        name: alt && /\.[a-z0-9]{2,5}$/i.test(alt) ? alt : `image-${index}.${extension}`,
        mimeType,
        driveId: null,
        buffer,
        byteLength: buffer.byteLength,
        error: null,
      };
    } catch (error) {
      console.warn('[AI Studio Exporter] Could not read image:', error);
      return null;
    }
  }

  /**
   * Attachments render as a chip with a title and a size, and sometimes a
   * thumbnail. The page never holds the underlying file, so scraping can only
   * ever recover the label; the API path is what retrieves real bytes.
   */
  async function readAttachmentChunks(turnEl, settings, counter) {
    const parts = [];

    for (const chunk of turnEl.querySelectorAll('ms-file-chunk')) {
      let name = 'attachment';
      if (settings.scrapeAttachmentTitle) {
        const label = chunk.querySelector('span:not([class*="icon"])');
        name = (label ? label.innerText : '').trim() || 'attachment';
      }

      let sizeLabel = '';
      if (settings.scrapeAttachmentSize) {
        const container = chunk.querySelector('.file-chunk-container');
        sizeLabel = ((container && container.lastElementChild && container.lastElementChild.innerText) || '').trim();
      }

      const part = {
        type: 'file', name, mimeType: null, driveId: null,
        buffer: null, byteLength: null, sizeLabel,
        error: 'Only the preview is available when scraping the page',
      };

      if (settings.scrapeAttachmentPreview) {
        const preview = chunk.querySelector('img');
        if (preview) {
          const image = await readImageElement(preview, ++counter.value);
          if (image) {
            image.name = `preview-${counter.value}-${image.name}`;
            parts.push(image);
          }
        }
      }

      parts.push(part);
    }

    return parts;
  }

  // --- turn extraction ----------------------------------------------------

  const textOf = (el) => (el ? (el.innerText || '').trim() : '');

  /**
   * Read one chat turn into normalized turns.
   *
   * Returns an array because a single model turn can yield two: its reasoning
   * and its answer. The previous implementation returned early on finding a
   * reasoning block, so the answer was discarded; likewise a user message with
   * both an image and a caption lost the caption. Every piece of content on the
   * turn is now collected instead of the first match winning.
   */
  async function extractTurn(turnEl, settings, counter) {
    const container = turnEl.querySelector('[data-turn-role]');
    if (!container) return [];

    const role = container.getAttribute('data-turn-role') === 'Model' ? 'model' : 'user';
    const turns = [];

    if (role === 'model' && settings.scrapeReasoning) {
      const reasoning = await extractReasoning(turnEl);
      if (reasoning) {
        turns.push(AISE.model.makeTurn('model', reasoning, { isThought: true }));
      }
    }

    const parts = [];
    if (settings.scrapeImages) {
      // querySelectorAll, not querySelector: a turn may carry several images
      // and only the first was ever captured before.
      for (const img of turnEl.querySelectorAll('img.loaded-image')) {
        const image = await readImageElement(img, ++counter.value);
        if (image) parts.push(image);
      }
    }
    if (settings.scrapeAttachments) {
      parts.push(...(await readAttachmentChunks(turnEl, settings, counter)));
    }

    // The reasoning panel contributes its own ms-text-chunk, so for a model
    // turn the answer is the last one rather than the first.
    const chunks = turnEl.querySelectorAll('ms-text-chunk');
    const answerChunk = role === 'model' && chunks.length > 1 ? chunks[chunks.length - 1] : chunks[0];
    const text = textOf(answerChunk);

    if (text || parts.length) {
      const turn = AISE.model.makeTurn(role, text);
      turn.parts = parts;
      turns.push(turn);
    }

    return turns;
  }

  async function extractReasoning(turnEl) {
    const chevron = Array.from(turnEl.querySelectorAll('span')).find(
      (span) => span.textContent.trim() === 'chevron_right'
    );
    if (!chevron) return null;

    chevron.click();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY);

    const panel = turnEl.querySelector('.mat-expansion-panel-body ms-text-chunk');
    const text = panel ? panel.textContent.replace(/^\s+|\s+$/g, '') : null;

    chevron.click();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY);

    return text || null;
  }

  // --- fallback extractor -------------------------------------------------

  /**
   * Scrape the rendered page into a Conversation. Registered on AISE so the
   * pipeline in src/export.js can reach it without a circular dependency.
   */
  async function domExtract(settings, report, cancelled) {
    CONFIG.ELEMENT_LOAD_DELAY = settings.loadDelay || CONFIG.ELEMENT_LOAD_DELAY;

    const promptId = AISE.exporter.currentPromptId();
    const conversation = AISE.model.emptyConversation(promptId, 'dom');

    const titleEl = document.querySelector('.actions.pointer.mode-title');
    if (titleEl) conversation.title = textOf(titleEl) || conversation.title;

    let restoreRawMode = false;
    report('Enabling raw output mode…');

    try {
      const toggle = await ensureMoreActionsMenuOpen();
      if (!isRawModeEnabled()) {
        toggle.click();
        await sleep(CONFIG.ELEMENT_LOAD_DELAY * 5);
        restoreRawMode = true;
      }
    } finally {
      await closeMoreActionsMenuIfOpen();
    }

    const turnElements = document.querySelectorAll('ms-chat-turn');
    if (!turnElements.length) throw new Error('No chat turns found on the page');

    const counter = { value: 0 };
    for (let i = 0; i < turnElements.length; i++) {
      if (cancelled && cancelled()) throw new Error('Export cancelled');
      report('Reading messages from the page…', `${i + 1} / ${turnElements.length}`);

      turnElements[i].scrollIntoView();
      await sleep(CONFIG.ELEMENT_LOAD_DELAY);
      conversation.turns.push(...(await extractTurn(turnElements[i], settings, counter)));
    }

    if (restoreRawMode) {
      try {
        (await ensureMoreActionsMenuOpen()).click();
        await sleep(CONFIG.ELEMENT_LOAD_DELAY);
      } catch (error) {
        console.warn('[AI Studio Exporter] Could not restore raw output mode:', error);
      } finally {
        await closeMoreActionsMenuIfOpen();
      }
    }

    return AISE.model.recomputeStats(conversation);
  }

  AISE.domExtract = domExtract;

  // --- entry point --------------------------------------------------------

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(AI_STUDIO_DEFAULT_SETTINGS, (stored) => resolve(sanitizeSettings(stored)));
    });
  }

  /**
   * Set the toolbar badge. Content scripts cannot reach chrome.action, so the
   * service worker does it; failures are ignored because a badge that could
   * not be painted must never take an export down with it.
   */
  const setBadge = (state, text, kind) => {
    try {
      chrome.runtime.sendMessage(
        { action: 'status:set', state, text, kind },
        () => chrome.runtime.lastError
      );
    } catch (_) {
      // Extension context invalidated; the export is about to fail anyway.
    }
  };

  /**
   * Shared wrapper for both export kinds: one at a time, overlay up, overlay
   * always torn down. `silent` suppresses the overlay for scheduled backups,
   * which run in a background tab the user is not looking at; the badge is
   * deliberately not suppressed, because it is the only way an unattended
   * backup can report that it failed.
   */
  async function runExport(request, work) {
    if (isExporting) return { success: false, message: 'An export is already running' };

    const library = request.action === 'exportLibrary';
    isExporting = true;
    shouldCancel = false;
    progress = emptyProgress();
    if (!request.silent) showLoadingOverlay(library ? 'Exporting library' : 'Exporting conversation');
    setBadge('running');

    let downgraded = false;
    try {
      const settings = await getSettings();
      CONFIG.ELEMENT_LOAD_DELAY = settings.loadDelay;

      const requested = request.formatId || request.format || settings.defaultFormat || 'markdown';
      const resolved = await AISE.license.resolveFormat(requested);
      const { format, reason } = resolved;
      downgraded = resolved.downgraded;
      // A note rather than a status message: it used to be written over the
      // status line and then overwritten a moment later by the first real
      // stage, so the one thing worth reading was the one thing that flashed.
      if (downgraded) {
        progress.note = reason;
        paintOverlay();
      }

      const result = await work({
        settings,
        formatId: format.id,
        report: setProgress,
        shouldCancel: () => shouldCancel,
        // Fires the moment the API path is abandoned, so the badge and the
        // overlay can say so while the slow part is still running.
        onSource: (source) => {
          if (source === 'dom' && progress && progress.tone !== 'muted') progress.tone = 'warn';
          paintOverlay();
          setBadge(source === 'dom' ? 'reading' : 'running');
        },
      });

      if (downgraded && result && result.success) {
        result.message = `${result.message} · ${reason}`;
      }
      setBadge(
        AISE.badge.outcomeFor(result, downgraded),
        result && result.message,
        downgraded ? 'downgrade' : null
      );
      return result;
    } catch (error) {
      console.error('[AI Studio Exporter] Export failed:', error);
      const message = error && error.message ? error.message : String(error);
      setBadge('failed', message);
      return { success: false, message };
    } finally {
      isExporting = false;
      shouldCancel = false;
      progress = null;
      hideLoadingOverlay();
    }
  }

  const runSingleExport = (request) =>
    runExport(request, (options) => AISE.exporter.exportConversation(options));

  /**
   * Whole-library export is a Pro feature in its own right, not just a Pro
   * format, so it is checked here rather than trusting the popup to have
   * disabled the button.
   */
  async function runLibraryExport(request) {
    if (!(await AISE.license.isPro({ skipRevalidation: true }))) {
      // Badged rather than merely returned: the popup closes the moment it
      // sends this message, so nothing is listening for the reply.
      const message = 'Library export requires a Pro licence.';
      setBadge('failed', message);
      return { success: false, message };
    }
    return runExport(request, (options) =>
      AISE.batch.exportLibrary(Object.assign({ filters: request.filters || {} }, options))
    );
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const senderUrl = sender && sender.url;
    const isInternal =
      sender && sender.id === chrome.runtime.id &&
      (!senderUrl || senderUrl.startsWith(chrome.runtime.getURL('')));

    if (!isInternal) {
      if (sendResponse) sendResponse({ success: false, message: 'Invalid sender' });
      return false;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') {
      if (sendResponse) sendResponse({ success: false, message: 'Invalid request' });
      return false;
    }
    if (!ALLOWED_ACTIONS.has(request.action)) {
      sendResponse({ success: false, message: 'Unsupported action' });
      return false;
    }

    if (request.action === 'export') {
      runSingleExport(request).then(sendResponse);
      return true; // responds asynchronously
    }
    if (request.action === 'exportLibrary') {
      runLibraryExport(request).then(sendResponse);
      return true;
    }
    if (request.action === 'getStatus') {
      // The popup polls this while it is open, so it can show live progress
      // rather than the word "exporting".
      sendResponse({ isExporting, progress: progress ? Object.assign({}, progress) : null });
      return false;
    }

    shouldCancel = true;
    sendResponse({ success: true });
    return false;
  });

  // Injection marker. The isolated world is invisible from the page and from
  // devtools automation, so without this there is no way to tell "extension not
  // loaded" apart from "extension loaded but broken"; which is the first thing
  // worth knowing in any bug report.
  document.documentElement.dataset.aiStudioExporter =
    (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || 'unknown';

  console.log('[AI Studio Exporter] content script ready');
})(typeof globalThis !== 'undefined' ? globalThis : self);
