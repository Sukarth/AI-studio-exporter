const AI_STUDIO_DEFAULT_SETTINGS = Object.freeze({
  scrapeImages: true,
  scrapeAttachments: true,
  scrapeAttachmentPreview: true,
  scrapeAttachmentTitle: true,
  scrapeAttachmentSize: true,
  scrapeReasoning: true,
  loadDelay: 700
});

function sanitizeSettings(raw = {}) {
  const sanitized = { ...AI_STUDIO_DEFAULT_SETTINGS };

  const coerceBoolean = (value, fallback) =>
    typeof value === 'boolean' ? value : fallback;

  sanitized.scrapeImages = coerceBoolean(raw.scrapeImages, sanitized.scrapeImages);
  sanitized.scrapeAttachments = coerceBoolean(raw.scrapeAttachments, sanitized.scrapeAttachments);
  sanitized.scrapeAttachmentPreview = coerceBoolean(raw.scrapeAttachmentPreview, sanitized.scrapeAttachmentPreview);
  sanitized.scrapeAttachmentTitle = coerceBoolean(raw.scrapeAttachmentTitle, sanitized.scrapeAttachmentTitle);
  sanitized.scrapeAttachmentSize = coerceBoolean(raw.scrapeAttachmentSize, sanitized.scrapeAttachmentSize);
  sanitized.scrapeReasoning = coerceBoolean(raw.scrapeReasoning, sanitized.scrapeReasoning);

  const parsedDelay = Number(raw.loadDelay);
  if (Number.isFinite(parsedDelay) && parsedDelay >= 200 && parsedDelay <= 5000) {
    sanitized.loadDelay = Math.round(parsedDelay);
  }

  return sanitized;
}

function isAIStudioUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'aistudio.google.com' &&
      /^\/(?:u\/\d+\/)?prompts\//.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}
