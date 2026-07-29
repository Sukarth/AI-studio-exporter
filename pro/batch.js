/**
 * Batch export of the whole conversation library.
 *
 * Only possible because of the API path: the DOM route would have to open each
 * conversation in a tab and scroll it, which is what made the previous attempt
 * at this feature impractical. Here it is a loop over ResolveDriveResource.
 *
 * Two constraints shape the design:
 *
 *  - Memory. Holding hundreds of conversations plus their attachments in a
 *    single archive will exhaust the tab. Output is therefore split into
 *    volumes at a size threshold, and attachments can be skipped entirely.
 *  - Partial failure. One unreadable conversation must not lose the other
 *    three hundred. Failures are recorded and reported in the manifest rather
 *    than aborting the run.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  // Start a new archive once the buffered content passes this. Rough, since it
  // counts pre-compression bytes, but it is the number that predicts memory.
  const VOLUME_BYTES = 256 * 1024 * 1024;

  // Conversations fetched concurrently. The bottleneck is Google's per-user
  // rate limit rather than local CPU.
  const CONCURRENCY = 3;

  const now = () => Date.now();

  /** Apply the user's filters to the library index. */
  function selectConversations(index, filters) {
    let selected = index.slice();

    if (filters.since) selected = selected.filter((c) => c.modifiedAt && c.modifiedAt >= filters.since);
    if (filters.until) selected = selected.filter((c) => c.modifiedAt && c.modifiedAt <= filters.until);

    if (filters.titleQuery) {
      const needle = filters.titleQuery.toLowerCase();
      selected = selected.filter((c) => (c.title || '').toLowerCase().includes(needle));
    }

    if (filters.onlyIds && filters.onlyIds.length) {
      const wanted = new Set(filters.onlyIds);
      selected = selected.filter((c) => wanted.has(c.id));
    }

    // Skip anything already exported and unchanged since. This is what makes
    // scheduled backups cheap.
    if (filters.skipUnchangedSince) {
      const seen = filters.skipUnchangedSince;
      selected = selected.filter((c) => !seen[c.id] || !c.modifiedAt || c.modifiedAt > seen[c.id]);
    }

    selected.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
    if (filters.limit > 0) selected = selected.slice(0, filters.limit);
    return selected;
  }

  /**
   * Give every conversation a unique folder name. Titles collide often — AI
   * Studio auto-names many conversations identically — so the id is appended
   * only when a collision actually occurs, keeping the common case readable.
   */
  function makeFolderNamer() {
    const used = new Set();
    return (conversation) => {
      const base = AISE.exporter.safeFilename(conversation.title, 'conversation');
      let name = base;
      if (used.has(name.toLowerCase())) name = `${base} (${conversation.id.slice(0, 6)})`;
      let n = 2;
      while (used.has(name.toLowerCase())) name = `${base} (${conversation.id.slice(0, 6)}-${n++})`;
      used.add(name.toLowerCase());
      return name;
    };
  }

  function buildIndexMarkdown(entries, failures, startedAt) {
    const lines = [
      '# AI Studio Library Export',
      '',
      `**Exported:** ${new Date(startedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC  `,
      `**Conversations:** ${entries.length}  `,
    ];
    if (failures.length) lines.push(`**Failed:** ${failures.length}  `);
    lines.push('', '---', '');

    for (const entry of entries) {
      const modified = entry.modifiedAt
        ? new Date(entry.modifiedAt).toISOString().slice(0, 10)
        : 'unknown';
      lines.push(`- [${entry.title}](${encodeURI(entry.path)}) — ${modified} · ${entry.turnCount} messages`);
    }

    if (failures.length) {
      lines.push('', '## Not exported', '');
      for (const failure of failures) {
        lines.push(`- **${failure.title || failure.id}** — ${failure.error}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Run a full library export.
   *
   * @param {Object} options
   * @param {Object} options.settings
   * @param {string} options.formatId
   * @param {Object} options.filters
   * @param {(stage: string, detail?: string) => void} options.report
   * @param {() => boolean} options.shouldCancel
   */
  async function exportLibrary(options) {
    const { settings, filters = {}, report = () => {}, shouldCancel = () => false } = options;
    const format = AISE.formats[options.formatId] || AISE.formats.markdown;
    const startedAt = now();

    report('Listing your library…');
    const index = await AISE.api.listAllPrompts((count) => report('Listing your library…', `${count} found`));

    const selected = selectConversations(index, filters);
    if (!selected.length) {
      return { success: false, message: 'No conversations matched the current filters.' };
    }

    const wantsAttachments = !!(settings.scrapeAttachments || settings.scrapeImages) && !filters.skipAttachments;
    const nameFolder = makeFolderNamer();

    // A concatenable format (JSONL, CSV) becomes one dataset file rather than
    // hundreds of tiny ones, which is how those formats are actually consumed.
    const concatenate = !!format.concatenable;

    const volumes = [];
    let zip = new JSZip();
    let bufferedBytes = 0;
    let volumeEntries = [];
    const concatenatedChunks = [];
    const entries = [];
    const failures = [];
    const exportedAt = {};
    let concatenatedCount = 0;
    let done = 0;

    const flushVolume = async () => {
      if (!volumeEntries.length) return;
      volumes.push({ zip, entries: volumeEntries });
      zip = new JSZip();
      bufferedBytes = 0;
      volumeEntries = [];
    };

    const handle = async (summary) => {
      if (shouldCancel()) return;
      try {
        const conversation = await AISE.api.fetchConversation(summary.id);

        if (wantsAttachments) {
          await AISE.attachments.resolveAttachments(conversation, null, shouldCancel);
        }
        AISE.model.applySettings(conversation, settings);

        const { assetPaths, files } = AISE.exporter.planAssets(conversation);
        const rendered = await format.render(conversation, settings, assetPaths);

        if (concatenate) {
          // Only the first chunk keeps the format's preamble — a CSV with a
          // header row repeated every few hundred lines is not a dataset.
          if (rendered) {
            const chunk =
              concatenatedChunks.length && format.preamble && rendered.startsWith(format.preamble)
                ? rendered.slice(format.preamble.length)
                : rendered;
            concatenatedChunks.push(chunk);
            bufferedBytes += chunk.length;
            concatenatedCount++;
          }
        } else {
          const folder = nameFolder(conversation);
          // JSZip takes a Blob or a string equally happily.
          zip.file(`${folder}/conversation.${format.extension}`, rendered);
          bufferedBytes += format.binary ? (rendered.size || 0) : rendered.length;

          for (const { path, part } of files) {
            if (part.buffer) {
              zip.file(`${folder}/${path}`, part.buffer);
              bufferedBytes += part.byteLength || 0;
            } else if (part.dataBase64) {
              zip.file(`${folder}/${path}`, part.dataBase64, { base64: true });
              bufferedBytes += part.byteLength || 0;
            }
          }

          const entry = {
            title: conversation.title,
            path: `${folder}/conversation.${format.extension}`,
            modifiedAt: conversation.modifiedAt,
            turnCount: conversation.stats.turnCount,
          };
          entries.push(entry);
          volumeEntries.push(entry);
        }

        exportedAt[summary.id] = summary.modifiedAt || now();
      } catch (error) {
        failures.push({
          id: summary.id,
          title: summary.title,
          error: error && error.message ? error.message : String(error),
        });
      } finally {
        done++;
        report(
          `Exporting conversations… ${failures.length ? `(${failures.length} failed)` : ''}`.trim(),
          `${done} / ${selected.length}`
        );
        if (!concatenate && bufferedBytes >= VOLUME_BYTES) await flushVolume();
      }
    };

    // Fixed-size worker pool over the selection.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
        while (cursor < selected.length && !shouldCancel()) {
          await handle(selected[cursor++]);
        }
      })
    );

    if (shouldCancel()) throw new Error('Export cancelled');
    if (!entries.length && !concatenatedChunks.length) {
      throw new Error(
        `None of the ${selected.length} conversations could be exported. ` +
          (failures[0] ? `First error: ${failures[0].error}` : '')
      );
    }

    report('Packaging…');
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const downloads = [];

    if (concatenate) {
      const blob = new Blob(concatenatedChunks, { type: `${format.mimeType};charset=utf-8` });
      downloads.push({ blob, filename: `ai-studio-library-${stamp}.${format.extension}` });
    } else {
      await flushVolume();
      volumes.forEach((volume, i) => {
        volume.zip.file('index.md', buildIndexMarkdown(volume.entries, i === 0 ? failures : [], startedAt));
        volume.zip.file(
          'manifest.json',
          JSON.stringify(
            {
              exporter: 'ai-studio-exporter',
              exportedAt: new Date(startedAt).toISOString(),
              format: format.id,
              volume: i + 1,
              volumeCount: volumes.length,
              conversations: volume.entries,
              failures: i === 0 ? failures : [],
            },
            null,
            2
          )
        );
      });

      for (let i = 0; i < volumes.length; i++) {
        report('Packaging…', volumes.length > 1 ? `archive ${i + 1} / ${volumes.length}` : '');
        const blob = await volumes[i].zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const suffix = volumes.length > 1 ? ` (part ${i + 1} of ${volumes.length})` : '';
        downloads.push({ blob, filename: `ai-studio-library-${stamp}${suffix}.zip` });
      }
    }

    for (const download of downloads) {
      AISE.exporter.triggerDownload(download.blob, download.filename);
      // Chrome drops downloads fired in the same tick; space them out.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    // A concatenable format can legitimately produce nothing for a conversation
    // — JSONL skips anything without an assistant reply — so count what landed
    // in the file rather than what was attempted.
    const parts = [`Exported ${concatenate ? concatenatedCount : entries.length} conversations`];
    if (downloads.length > 1) parts.push(`${downloads.length} archives`);
    if (failures.length) parts.push(`${failures.length} failed`);

    return {
      success: true,
      message: parts.join(' · '),
      exportedAt,
      failures,
      files: downloads.map((d) => d.filename),
    };
  }

  AISE.batch = { exportLibrary, selectConversations, makeFolderNamer, buildIndexMarkdown, VOLUME_BYTES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
