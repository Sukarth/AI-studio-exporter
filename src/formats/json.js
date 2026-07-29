/**
 * JSON formatter — the full normalized model, minus the raw asset bytes.
 *
 * This is the lossless format: anything the extractor captured is here, so it
 * doubles as the input for re-import and for the Pro converters. Asset bytes
 * are replaced by their in-archive path, keeping the JSON readable and letting
 * the ZIP hold the binaries once rather than base64'd twice.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const SCHEMA_VERSION = 1;

  function render(conversation, settings, assetPaths) {
    const paths = assetPaths || new Map();

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      exporter: 'ai-studio-exporter',
      id: conversation.id,
      title: conversation.title,
      url: settings.includeSourceUrl ? conversation.url : undefined,
      source: conversation.source,
      exportedAt: new Date(conversation.exportedAt).toISOString(),
      modifiedAt: conversation.modifiedAt ? new Date(conversation.modifiedAt).toISOString() : null,
      config: settings.includeModelConfig ? conversation.config : undefined,
      systemInstruction: settings.includeSystemInstruction ? conversation.systemInstruction : undefined,
      stats: conversation.stats,
      turns: conversation.turns.map((turn) => ({
        role: turn.role,
        isThought: turn.isThought,
        text: turn.text,
        tokenCount: settings.includeTokenCounts ? turn.tokenCount : undefined,
        timestamp: settings.includeTimestamps && turn.timestamp ? new Date(turn.timestamp).toISOString() : undefined,
        parts: turn.parts.length
          ? turn.parts.map((part) => ({
              type: part.type,
              name: part.name,
              mimeType: part.mimeType,
              driveId: part.driveId,
              byteLength: part.byteLength,
              path: paths.get(part) || null,
            }))
          : undefined,
      })),
    };

    return JSON.stringify(payload, (_key, value) => (value === undefined ? undefined : value), 2);
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.json = {
    id: 'json',
    label: 'JSON (.json)',
    extension: 'json',
    mimeType: 'application/json',
    pro: false,
    bundlesAssets: true,
    render,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
