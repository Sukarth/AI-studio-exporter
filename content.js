/***
 * Content script for the AI Studio Exporter.
 *
 * Two responsibilities:
 *   1. The progress overlay and the message channel to the popup.
 *   2. A DOM-scraping extractor, used only when the API path fails.
 *
 * Scraping is the fallback, not the primary route. It is slow — every turn has
 * to be scrolled into view and given time to render — and it can only see what
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
  const ALLOWED_ACTIONS = new Set(['export', 'getStatus', 'cancel']);

  let isExporting = false;
  let shouldCancel = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- progress overlay ---------------------------------------------------

  function showLoadingOverlay() {
    if (document.getElementById('ai-studio-export-overlay')) return;

    if (!document.getElementById('ai-studio-export-style')) {
      const style = document.createElement('style');
      style.id = 'ai-studio-export-style';
      style.textContent = `
        @keyframes aise-spin { to { transform: rotate(360deg); } }
        #ai-studio-export-overlay {
          position: fixed; inset: 0; z-index: 999999;
          display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,.65); backdrop-filter: blur(8px);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        #ai-studio-export-overlay .aise-card {
          background:#25262b; color:#e9ecef; border:1px solid #2c2e33;
          border-radius:16px; padding:40px; width:90%; max-width:400px;
          text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.4);
        }
        #ai-studio-export-overlay .aise-spinner {
          width:50px; height:50px; margin:0 auto 24px; border-radius:50%;
          border:3px solid rgba(102,126,234,.2); border-top-color:#667eea;
          animation: aise-spin 1s linear infinite;
        }
        #ai-studio-export-overlay h2 { margin:0 0 12px; font-size:20px; font-weight:600; color:#fff; }
        #ai-studio-export-status { margin:0; font-size:14px; line-height:1.6; color:#a5a5a5; }
        #ai-studio-export-progress {
          margin:24px 0 20px; padding-top:24px; border-top:1px solid #2c2e33;
          color:#667eea; font-size:13px; font-weight:600;
        }
        #ai-studio-export-cancel {
          background:transparent; border:1px solid #c92a2a; color:#ff8787;
          padding:8px 16px; border-radius:6px; font-size:13px; font-weight:500; cursor:pointer;
        }
        #ai-studio-export-cancel:hover { background:rgba(201,42,42,.1); }
        #ai-studio-export-cancel:disabled { opacity:.7; cursor:not-allowed; }
      `;
      document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.id = 'ai-studio-export-overlay';
    overlay.innerHTML = `
      <div class="aise-card" role="dialog" aria-live="polite" aria-label="Exporting conversation">
        <div class="aise-spinner"></div>
        <h2>Exporting Conversation…</h2>
        <p id="ai-studio-export-status">Starting…</p>
        <div id="ai-studio-export-progress"></div>
        <button id="ai-studio-export-cancel" type="button">Cancel Export</button>
      </div>`;

    // Swallow interaction so a stray click can't disturb the page mid-export.
    for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup']) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

    overlay.querySelector('#ai-studio-export-cancel').addEventListener('click', (event) => {
      shouldCancel = true;
      const button = event.currentTarget;
      button.textContent = 'Cancelling…';
      button.disabled = true;
    });

    document.body.appendChild(overlay);
  }

  function updateLoadingStatus(message, progress) {
    const status = document.getElementById('ai-studio-export-status');
    const detail = document.getElementById('ai-studio-export-progress');
    if (status && message) status.textContent = message;
    if (detail) detail.textContent = progress || '';
  }

  function hideLoadingOverlay() {
    const overlay = document.getElementById('ai-studio-export-overlay');
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
   * document.body.innerHTML — an operation that grew with conversation length
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
   * ever recover the label — the API path is what retrieves real bytes.
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
   * reasoning block, so the answer was discarded — likewise a user message with
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

  async function runExport(request) {
    if (isExporting) return { success: false, message: 'An export is already running' };

    isExporting = true;
    shouldCancel = false;
    showLoadingOverlay();

    try {
      const settings = await getSettings();
      CONFIG.ELEMENT_LOAD_DELAY = settings.loadDelay;

      return await AISE.exporter.exportConversation({
        settings,
        formatId: request.format || settings.defaultFormat || 'markdown',
        report: (message, progress) => updateLoadingStatus(message, progress),
        shouldCancel: () => shouldCancel,
      });
    } catch (error) {
      console.error('[AI Studio Exporter] Export failed:', error);
      return { success: false, message: error && error.message ? error.message : String(error) };
    } finally {
      isExporting = false;
      shouldCancel = false;
      hideLoadingOverlay();
    }
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
      runExport(request).then(sendResponse);
      return true; // responds asynchronously
    }
    if (request.action === 'getStatus') {
      sendResponse({ isExporting });
      return false;
    }

    shouldCancel = true;
    sendResponse({ success: true });
    return false;
  });

  console.log('[AI Studio Exporter] content script ready');
})(typeof globalThis !== 'undefined' ? globalThis : self);
