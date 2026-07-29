/**
 * Attachment resolution.
 *
 * A decoded conversation carries attachments as bare 33-character Drive ids —
 * no filename, no MIME type, no bytes. This turns them into real files.
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

  async function resolvePart(part) {
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
    } catch (error) {
      part.error = error && error.message ? error.message : String(error);
      // Even a failed download usually got far enough to name the file.
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
   * Fetch bytes for every Drive-referenced part in a conversation, in place.
   * `onProgress(done, total)` fires after each attachment settles.
   */
  async function resolveAttachments(conversation, onProgress, shouldCancel) {
    const parts = conversation.turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.driveId && !part.buffer);

    if (!parts.length) return { resolved: 0, failed: 0, total: 0 };

    let done = 0;
    await pooled(parts, CONCURRENCY, async (part) => {
      if (typeof shouldCancel === 'function' && shouldCancel()) return;
      await resolvePart(part);
      done++;
      if (typeof onProgress === 'function') onProgress(done, parts.length);
    });

    const failed = parts.filter((p) => p.error).length;
    AISE.model.recomputeStats(conversation);
    return { resolved: parts.length - failed, failed, total: parts.length };
  }

  AISE.attachments = { resolveAttachments, chooseFilename, EXTENSION_BY_MIME };
})(typeof globalThis !== 'undefined' ? globalThis : self);
