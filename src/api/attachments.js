/**
 * Attachment resolution.
 *
 * A decoded conversation carries attachments as bare 33-character Drive ids —
 * no filename, no MIME type, no bytes. This turns them into real files.
 *
 * Resolution is two-phase on purpose. Metadata is cheap and is the only thing
 * that says whether an id is an image or a document, and the user may have
 * asked for only one of those. Downloading first and filtering afterwards —
 * which is what this used to do — meant paying for every byte of a 200MB
 * conversation to then throw most of it away.
 *
 * Failure here is deliberately non-fatal. An attachment can be in someone
 * else's Drive, revoked, or trashed, and none of that should cost the user the
 * rest of a long export. A part that cannot be fetched keeps whatever metadata
 * we did get plus an `error`, and formatters render it as present-but-
 * unavailable rather than silently omitting it.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  // Drive rate-limits per user. Four in flight keeps a 40-attachment
  // conversation quick without tripping 403 rateLimitExceeded.
  const CONCURRENCY = 4;

  // Exporting the same conversation again in a different format is the common
  // case — someone wants the Markdown and the PDF — and re-downloading every
  // attachment for it is pure waste. Cached bytes live for the lifetime of the
  // page, capped so a few large conversations cannot pin unbounded memory.
  const CACHE_BYTE_BUDGET = 128 * 1024 * 1024;

  const cache = new Map();
  let cachedBytes = 0;

  function cacheGet(driveId) {
    return cache.get(driveId) || null;
  }

  function cachePut(driveId, entry) {
    const previous = cache.get(driveId);
    if (previous && previous.buffer) cachedBytes -= previous.buffer.byteLength;

    cache.set(driveId, entry);
    if (entry.buffer) cachedBytes += entry.buffer.byteLength;

    // Insertion order is iteration order, so the oldest buffered entry is the
    // first one found. Metadata-only entries are kept: they cost nothing and
    // they are what makes a repeat export skip the filtering round-trip.
    for (const [id, held] of cache) {
      if (cachedBytes <= CACHE_BYTE_BUDGET) break;
      if (id === driveId || !held.buffer) continue;
      cachedBytes -= held.buffer.byteLength;
      cache.set(id, Object.assign({}, held, { buffer: null }));
    }
  }

  function clearCache() {
    cache.clear();
    cachedBytes = 0;
  }

  const EXTENSION_BY_MIME = {
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'application/json': 'json',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/zip': 'zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };

  /**
   * Pick the extension the bytes actually warrant. The name Drive reports wins
   * when it already carries a usable extension, except for native documents,
   * where the export changed the format out from under the original name.
   */
  function chooseFilename(name, mimeType, exportedExtension) {
    const fallback = EXTENSION_BY_MIME[mimeType] || 'bin';
    const base = (name || 'attachment').replace(/[/\\?%*:|"<>]/g, '-').trim() || 'attachment';

    if (exportedExtension) {
      return `${base.replace(/\.[^.]{1,8}$/, '')}.${exportedExtension}`;
    }
    return /\.[^.]{1,8}$/.test(base) ? base : `${base}.${fallback}`;
  }

  const isImage = (mimeType) => typeof mimeType === 'string' && mimeType.startsWith('image/');

  /**
   * Whether the user asked for this kind of attachment. Called after metadata
   * and before bytes, which is the whole point of the split.
   */
  function wanted(part, settings) {
    if (!settings) return true;
    return part.type === 'image' ? !!settings.scrapeImages : !!settings.scrapeAttachments;
  }

  /** Phase one: name and classify, without transferring the file itself. */
  async function describePart(part, useCache) {
    const cached = useCache && cacheGet(part.driveId);
    if (cached) {
      Object.assign(part, cached.meta);
      if (cached.buffer) {
        part.buffer = cached.buffer;
        part.byteLength = cached.buffer.byteLength;
      }
      return part;
    }

    try {
      const meta = await AISE.api.fetchAttachmentMetadata(part.driveId);
      const mimeType = meta.mimeType || '';
      // A native Google document is exported to a different format on download,
      // so its final name is not knowable yet. Only the class matters here.
      Object.assign(part, {
        name: chooseFilename(meta.name, mimeType, null),
        originalName: meta.name || null,
        mimeType,
        type: isImage(mimeType) ? 'image' : 'file',
        byteLength: meta.size || null,
        error: null,
      });
      if (useCache) cachePut(part.driveId, { meta: metaFields(part), buffer: null });
    } catch (error) {
      part.error = error && error.message ? error.message : String(error);
      part.type = part.type || 'file';
      if (!part.name) part.name = `attachment-${String(part.driveId).slice(0, 8)}`;
    }
    return part;
  }

  /** The subset of a part worth remembering between exports. */
  const metaFields = (part) => ({
    name: part.name,
    originalName: part.originalName || null,
    mimeType: part.mimeType || null,
    type: part.type,
    byteLength: part.byteLength || null,
  });

  /** Phase two: the bytes. */
  async function downloadPart(part, useCache) {
    if (part.buffer) return part;

    const cached = useCache && cacheGet(part.driveId);
    if (cached && cached.buffer) {
      Object.assign(part, cached.meta);
      part.buffer = cached.buffer;
      part.byteLength = cached.buffer.byteLength;
      part.error = null;
      return part;
    }

    try {
      const { meta, buffer, effectiveMimeType, exportedExtension } =
        await AISE.api.downloadAttachment(part.driveId);

      part.name = chooseFilename(meta.name, effectiveMimeType, exportedExtension);
      part.originalName = meta.name || null;
      part.mimeType = effectiveMimeType;
      part.type = isImage(effectiveMimeType) ? 'image' : 'file';
      part.buffer = buffer;
      part.byteLength = buffer.byteLength;
      part.error = null;

      if (useCache) cachePut(part.driveId, { meta: metaFields(part), buffer });
    } catch (error) {
      part.error = error && error.message ? error.message : String(error);
      if (!part.name) part.name = `attachment-${String(part.driveId).slice(0, 8)}`;
    }
    return part;
  }

  /** Run tasks with a fixed number in flight. */
  async function pooled(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    });
    await Promise.all(runners);
  }

  /**
   * Fetch bytes for the Drive-referenced parts a user's settings actually ask
   * for, in place.
   *
   * @param {Object} conversation
   * @param {(done: number, total: number) => void} [onProgress] - fires per download
   * @param {() => boolean} [shouldCancel]
   * @param {{settings?: Object, cache?: boolean}} [options]
   */
  async function resolveAttachments(conversation, onProgress, shouldCancel, options) {
    const settings = (options && options.settings) || null;
    const useCache = !options || options.cache !== false;
    const cancelled = () => typeof shouldCancel === 'function' && shouldCancel();

    const pending = conversation.turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.driveId && !part.buffer);

    if (!pending.length) return { resolved: 0, failed: 0, skipped: 0, total: 0 };

    await pooled(pending, CONCURRENCY, async (part) => {
      if (cancelled()) return;
      await describePart(part, useCache);
    });

    // Everything else is left named and classified but without bytes.
    // applySettings drops those by type and counts them, so an export still
    // says what was left out.
    const toDownload = pending.filter((part) => !part.error && wanted(part, settings));

    let done = 0;
    await pooled(toDownload, CONCURRENCY, async (part) => {
      if (cancelled()) return;
      await downloadPart(part, useCache);
      done++;
      if (typeof onProgress === 'function') onProgress(done, toDownload.length);
    });

    const failed = pending.filter((p) => p.error).length;
    AISE.model.recomputeStats(conversation);
    return {
      resolved: toDownload.filter((p) => !p.error).length,
      failed,
      skipped: pending.length - toDownload.length,
      total: pending.length,
    };
  }

  AISE.attachments = {
    resolveAttachments,
    chooseFilename,
    clearCache,
    EXTENSION_BY_MIME,
    CACHE_BYTE_BUDGET,
    // Test seam: lets a test assert on cache behaviour without exporting twice.
    _cache: cache,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
