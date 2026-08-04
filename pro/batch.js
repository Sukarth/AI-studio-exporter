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

  // Read through the export rather than closing over the constant, so the
  // splitting logic can be tested at a threshold of a few kilobytes instead of
  // by generating a quarter of a gigabyte of conversations.
  const volumeLimit = () => Number(AISE.batch && AISE.batch.VOLUME_BYTES) || VOLUME_BYTES;

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
   * Give every conversation a unique folder name. Titles collide often (AI
   * Studio auto-names many conversations identically), so the id is appended
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

  /**
   * The index every archive carries.
   *
   * It lists the whole export, not just the part it is sitting in. A
   * conversation held by another part is named and pointed at that part
   * instead of linked, so nothing in here is a link that resolves to nothing
   * and nothing in the export is unaccounted for.
   *
   * @param {Array} entries every conversation exported, each stamped with its volume
   * @param {{volume: number, volumeCount: number}} [place] omitted for a single archive
   */
  function buildIndexMarkdown(entries, failures, startedAt, place) {
    const volume = place ? place.volume : 1;
    const volumeCount = place ? place.volumeCount : 1;
    const split = volumeCount > 1;

    const lines = [
      '# AI Studio Library Export',
      '',
      `**Exported:** ${new Date(startedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC  `,
      `**Conversations:** ${entries.length}  `,
    ];
    if (failures.length) lines.push(`**Failed:** ${failures.length}  `);
    if (split) {
      lines.push(
        `**This archive:** part ${volume} of ${volumeCount}  `,
        '',
        `> The export was split across ${volumeCount} archives because of its size. Every part` +
          ' lists the whole library; conversations held by another part are marked below.' +
          ' Extract the parts side by side to browse them as one folder.'
      );
    }
    lines.push('', '---', '');

    for (const entry of entries) {
      const modified = entry.modifiedAt
        ? new Date(entry.modifiedAt).toISOString().slice(0, 10)
        : 'unknown';
      const facts = `${modified} · ${entry.turnCount} messages`;

      if (split && entry.volume !== volume) {
        lines.push(`- ${entry.title}: ${facts} · **in part ${entry.volume}**`);
        continue;
      }
      // Folder names carry a " (id)" suffix when titles collide, and a bare
      // encodeURI would leave those parentheses to end the link early.
      const target = AISE.formats.markdown.escapeTarget(entry.path);
      lines.push(`- [${entry.title}](${target}): ${facts}`);
    }

    if (failures.length) {
      lines.push('', '## Not exported', '');
      for (const failure of failures) {
        lines.push(`- **${failure.title || failure.id}**: ${failure.error}`);
      }
    }

    lines.push(
      '',
      '---',
      '',
      '_Exported with [AI Studio Exporter](https://github.com/Sukarth/AI-studio-exporter). ' +
        'What every file and field means: ' +
        '[format documentation](https://exportaistudio.vercel.app/docs)._'
    );

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
    // Formats can flag content they cannot represent; the PDF fonts cannot
    // draw non-Latin scripts. A single export reports this as it happens; here
    // there is no per-conversation status to attach it to, so it is collected
    // and reported once at the end rather than silently producing a few hundred
    // files full of question marks.
    const warnings = new Set();
    const exportedAt = {};
    let concatenatedCount = 0;
    let done = 0;

    // Synchronous on purpose: callers rely on being able to close a volume
    // between a size check and the writes that follow it, without yielding to
    // another conversation mid-way.
    const flushVolume = () => {
      if (!volumeEntries.length) return;
      // Stamp before sealing, so every index can say which part holds what.
      const number = volumes.length + 1;
      for (const entry of volumeEntries) entry.volume = number;
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
          // No caching here: every conversation is visited once, so a cache
          // would only compete with the archive for memory.
          await AISE.attachments.resolveAttachments(conversation, null, shouldCancel, {
            settings,
            cache: false,
          });
        }
        AISE.model.applySettings(conversation, settings);

        const { assetPaths, files } = AISE.exporter.planAssets(conversation);
        if (typeof format.warn === 'function') {
          const warning = format.warn(conversation);
          if (warning) warnings.add(warning);
        }
        const rendered = await format.render(conversation, settings, assetPaths);

        if (concatenate) {
          // Only the first chunk keeps the format's preamble; a CSV with a
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
          const documentBytes = format.binary ? rendered.size || 0 : rendered.length;
          const assetBytes = files.reduce((total, { part }) => total + (part.byteLength || 0), 0);

          // Everything from here to the end of this block runs without an
          // await, so a concurrent worker cannot flush between the size check
          // and the writes it guards.

          // Close the current volume *before* adding, not after. Checking
          // afterwards meant a volume could exceed the limit by however large
          // the conversation was; and conversations of hundreds of megabytes
          // are exactly the case volumes exist for. A volume can still exceed
          // the limit, but only when one conversation does on its own, which
          // is the one case that cannot be split any further.
          if (volumeEntries.length && bufferedBytes + documentBytes + assetBytes > volumeLimit()) {
            flushVolume();
          }

          const folder = nameFolder(conversation);
          // JSZip takes a Blob or a string equally happily.
          zip.file(`${folder}/conversation.${format.extension}`, rendered);
          bufferedBytes += documentBytes + assetBytes;

          for (const { path, part } of files) {
            if (part.buffer) zip.file(`${folder}/${path}`, part.buffer);
            else if (part.dataBase64) zip.file(`${folder}/${path}`, part.dataBase64, { base64: true });
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
      flushVolume();
      volumes.forEach((volume, i) => {
        // Every volume carries the whole library, not just its own share.
        // Splitting the index along with the files left each archive unable to
        // say where anything else went; whichever part you open now lists the
        // complete export and names the part holding each conversation.
        volume.zip.file(
          'index.md',
          buildIndexMarkdown(entries, failures, startedAt, { volume: i + 1, volumeCount: volumes.length })
        );
        volume.zip.file(
          'manifest.json',
          JSON.stringify(
            {
              exporter: 'ai-studio-exporter',
              exportedAt: new Date(startedAt).toISOString(),
              format: format.id,
              volume: i + 1,
              volumeCount: volumes.length,
              // The whole export, with the part number on each entry. Present
              // even in a single-volume export, so a consumer never has to
              // special-case one archive against many.
              library: entries,
              conversations: volume.entries,
              // Repeated in every part rather than only the first. A failure
              // list that exists in one archive out of three is a failure list
              // most people never see.
              failures,
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
    // (JSONL skips anything without an assistant reply), so count what landed
    // in the file rather than what was attempted.
    const parts = [`Exported ${concatenate ? concatenatedCount : entries.length} conversations`];
    if (downloads.length > 1) parts.push(`${downloads.length} archives`);
    if (failures.length) parts.push(`${failures.length} failed`);

    if (warnings.size) parts.push([...warnings][0]);

    return {
      success: true,
      message: parts.join(' · '),
      exportedAt,
      failures,
      warnings: [...warnings],
      files: downloads.map((d) => d.filename),
    };
  }

  AISE.batch = { exportLibrary, selectConversations, makeFolderNamer, buildIndexMarkdown, VOLUME_BYTES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
