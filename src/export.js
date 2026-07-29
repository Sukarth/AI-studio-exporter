/**
 * Export pipeline: acquire a conversation, render it, package it, download it.
 *
 * Acquisition is API-first with a DOM fallback. The API is undocumented and
 * Google can change it without notice, so any failure — a renumbered field, a
 * revoked session, a shape we don't recognise — drops through to scraping the
 * page, which is slower and captures less but has no dependency on internals.
 * `conversation.source` records which path ran so the UI can say so.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  /** Extract the prompt's Drive id from an AI Studio URL. */
  function currentPromptId(href) {
    const match = /\/prompts\/([A-Za-z0-9_-]{10,})/.exec(href || location.href);
    return match ? match[1] : null;
  }

  // Reserved device names on Windows: a file called CON.md cannot be created,
  // whatever extension it is given.
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  /**
   * Make a conversation title usable as a filename on Windows and POSIX.
   *
   * Internal spaces are kept, since titles read better than slugs, but every
   * character either platform rejects is replaced. Control characters are
   * written as escapes rather than literals so none end up embedded invisibly
   * in this file. A title consisting only of punctuation collapses to the
   * fallback instead of becoming a run of dashes.
   */
  function safeFilename(name, fallback) {
    const cleaned = String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.-]+$/g, '')
      .slice(0, 120)
      .trim();

    if (!cleaned) return fallback || 'conversation';
    return WINDOWS_RESERVED.test(cleaned) ? cleaned + '-export' : cleaned;
  }

  function timestampSlug(ms) {
    return new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /**
   * Name the archive after the conversation rather than the clock alone — a
   * folder of ai-studio-export-<timestamp>.zip files is unnavigable.
   */
  function buildBaseName(conversation) {
    return `${safeFilename(conversation.title, 'conversation')} - ${timestampSlug(conversation.exportedAt)}`;
  }

  /**
   * Assign each downloadable part a unique path inside the archive, and hand
   * back the map formatters use to link to them.
   */
  function planAssets(conversation) {
    const assetPaths = new Map();
    const files = [];
    const used = new Set();

    for (const turn of conversation.turns) {
      for (const part of turn.parts) {
        if (!part.buffer && !part.dataBase64) continue;

        let name = AISE.attachments.chooseFilename(part.name, part.mimeType, null);
        let candidate = name;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) {
          candidate = name.replace(/(\.[^.]+)?$/, (ext) => ` (${n})${ext || ''}`);
        }
        used.add(candidate.toLowerCase());

        const path = `attachments/${candidate}`;
        assetPaths.set(part, path);
        files.push({ path, part });
      }
    }

    return { assetPaths, files };
  }

  /**
   * Package a rendered conversation. A single text file with nothing alongside
   * it is downloaded as-is: wrapping a lone .md in a ZIP is friction users have
   * complained about, and there's nothing to bundle.
   */
  async function packageExport(conversation, format, settings) {
    const { assetPaths, files } = planAssets(conversation);
    const includeAssets = format.bundlesAssets && files.length > 0;
    const baseName = buildBaseName(conversation);

    // DOCX and PDF build their own container and return a Blob; the text
    // formats return a string. Await regardless, since either may be async.
    const rendered = await format.render(conversation, settings, assetPaths);
    const body = format.binary
      ? rendered
      : new Blob([rendered], { type: `${format.mimeType};charset=utf-8` });

    if (!includeAssets) {
      return { blob: body, filename: `${baseName}.${format.extension}`, assetCount: 0 };
    }

    const zip = new JSZip();
    zip.file(`conversation.${format.extension}`, body);
    for (const { path, part } of files) {
      if (part.buffer) zip.file(path, part.buffer);
      else if (part.dataBase64) zip.file(path, part.dataBase64, { base64: true });
    }

    return {
      blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }),
      filename: `${baseName}.zip`,
      assetCount: files.length,
    };
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the download a moment to start before invalidating the URL.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /**
   * Acquire a conversation, preferring the API.
   * @param {(stage: string, detail?: string) => void} report
   */
  async function acquireConversation(promptId, settings, report, shouldCancel) {
    if (promptId && AISE.api) {
      try {
        report('Reading conversation via AI Studio API…');
        const conversation = await AISE.api.fetchConversation(promptId);

        if (settings.scrapeAttachments || settings.scrapeImages) {
          const pending = conversation.turns.flatMap((t) => t.parts).filter((p) => p.driveId).length;
          if (pending) {
            report(`Downloading ${pending} attachment${pending === 1 ? '' : 's'}…`);
            await AISE.attachments.resolveAttachments(
              conversation,
              (done, total) => report(`Downloading attachments… (${done}/${total})`),
              shouldCancel
            );
          }
        }

        return conversation;
      } catch (error) {
        console.warn('[AI Studio Exporter] API path failed, falling back to page scraping:', error);
        report('API unavailable — falling back to reading the page…');
      }
    }

    if (typeof AISE.domExtract !== 'function') {
      throw new Error('Could not read this conversation via the API, and no fallback is available.');
    }
    return AISE.domExtract(settings, report, shouldCancel);
  }

  /**
   * Full single-conversation export.
   * @returns {Promise<{success: boolean, message: string, filename?: string}>}
   */
  async function exportConversation(options) {
    const { settings, formatId, report, shouldCancel } = options;
    const format = AISE.formats[formatId] || AISE.formats.markdown;

    const promptId = currentPromptId();
    const conversation = await acquireConversation(promptId, settings, report, shouldCancel);

    if (shouldCancel && shouldCancel()) throw new Error('Export cancelled');
    if (!conversation.turns.length) {
      throw new Error('No messages found in this conversation.');
    }

    AISE.model.applySettings(conversation, settings);

    // Formats can flag content they cannot represent — the PDF fonts, for
    // instance, cannot draw non-Latin scripts. Surface it rather than handing
    // back a file full of question marks with no explanation.
    const warning = typeof format.warn === 'function' ? format.warn(conversation) : null;
    if (warning) report(warning);

    report('Packaging…');
    const { blob, filename, assetCount } = await packageExport(conversation, format, settings);

    if (shouldCancel && shouldCancel()) throw new Error('Export cancelled');
    triggerDownload(blob, filename);

    const failed = conversation.turns
      .flatMap((t) => t.parts)
      .filter((p) => p.error).length;

    const parts = [`Exported ${conversation.stats.turnCount} messages`];
    if (assetCount) parts.push(`${assetCount} attachment${assetCount === 1 ? '' : 's'}`);
    if (failed) parts.push(`${failed} attachment${failed === 1 ? '' : 's'} unavailable`);
    if (conversation.source === 'dom') parts.push('reduced fidelity (page scraping)');

    return { success: true, message: parts.join(' · '), filename, warning };
  }

  AISE.exporter = {
    exportConversation,
    acquireConversation,
    packageExport,
    triggerDownload,
    currentPromptId,
    safeFilename,
    buildBaseName,
    planAssets,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
