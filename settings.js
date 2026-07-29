/**
 * Shared settings schema, defaults and sanitisation.
 *
 * Loaded by the popup, the options page and the content script, so it must stay
 * dependency-free.
 *
 * @license MIT
 */

const AI_STUDIO_DEFAULT_SETTINGS = Object.freeze({
  // Content capture
  scrapeImages: true,
  scrapeAttachments: true,
  scrapeAttachmentPreview: true,
  scrapeAttachmentTitle: true,
  scrapeAttachmentSize: true,
  scrapeReasoning: true,

  // Metadata the API exposes but the page does not render. Defaulting these on
  // makes exports richer than before; each is individually switchable because
  // some users want a clean transcript and nothing else.
  includeModelConfig: true,
  includeSystemInstruction: true,
  includeTimestamps: true,
  includeTokenCounts: true,
  includeSourceUrl: true,

  defaultFormat: 'markdown',
  loadDelay: 700,
});

const AI_STUDIO_FREE_FORMATS = Object.freeze(['markdown', 'json', 'text']);

const BOOLEAN_SETTINGS = Object.freeze(
  Object.keys(AI_STUDIO_DEFAULT_SETTINGS).filter(
    (key) => typeof AI_STUDIO_DEFAULT_SETTINGS[key] === 'boolean'
  )
);

function sanitizeSettings(raw = {}) {
  const sanitized = { ...AI_STUDIO_DEFAULT_SETTINGS };

  for (const key of BOOLEAN_SETTINGS) {
    if (typeof raw[key] === 'boolean') sanitized[key] = raw[key];
  }

  if (typeof raw.defaultFormat === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.defaultFormat)) {
    sanitized.defaultFormat = raw.defaultFormat;
  }

  const parsedDelay = Number(raw.loadDelay);
  if (Number.isFinite(parsedDelay) && parsedDelay >= 200 && parsedDelay <= 5000) {
    sanitized.loadDelay = Math.round(parsedDelay);
  }

  return sanitized;
}

function isAIStudioUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    return parsed.protocol === 'https:' && parsed.hostname === 'aistudio.google.com';
  } catch (error) {
    return false;
  }
}

/** A conversation page, as opposed to the library or another AI Studio route. */
function isAIStudioPromptUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    return isAIStudioUrl(maybeUrl) && /^\/(?:u\/\d+\/)?prompts\//.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

/** The library listing, where a batch export can start. */
function isAIStudioLibraryUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    return isAIStudioUrl(maybeUrl) && /^\/(?:u\/\d+\/)?library/.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}
