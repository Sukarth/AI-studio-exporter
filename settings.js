/**
 * Shared settings schema, defaults and sanitisation.
 *
 * Loaded by the popup, the options page and the content script, so it must stay
 * dependency-free.
 *
 * @license MIT
 */

/**
 * Storefront configuration — the only place either value is written down.
 *
 * Both are public by design. The organisation id names which Polar store to
 * ask about a key; it grants nothing on its own, which is why it can sit in an
 * open repository without weakening anything.
 */
const AI_STUDIO_PRO = Object.freeze({
  purchaseUrl: 'https://buy.polar.sh/polar_cl_zXcBSToqRBTzAPMZVxosZ3Fi116OohXGyXHtw3NVK7Q',
  polarOrganizationId: '23a764fc-aa21-4b92-857f-274a354d6f3a',
});

const AI_STUDIO_DEFAULT_SETTINGS = Object.freeze({
  // Content capture
  scrapeImages: true,
  scrapeAttachments: true,
  scrapeAttachmentPreview: true,
  scrapeAttachmentTitle: true,
  scrapeAttachmentSize: true,
  scrapeReasoning: true,

  // AI Studio files each attachment as its own message. Folding them into the
  // message they were sent with is what the user actually did, so it is on by
  // default; turning it off preserves AI Studio's own structure.
  condenseAttachments: true,

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

/**
 * Format catalogue for UI use.
 *
 * The formatters themselves live in content scripts and carry their own
 * metadata; this is a lightweight mirror so the popup and options page can
 * render a picker without loading every renderer (including the 0.76MB
 * document bundle) into an extension page that will never call them.
 *
 * Keep the ids in sync with pro/formats/ and src/formats/ — the test suite
 * asserts they match.
 */
const AI_STUDIO_FORMATS = Object.freeze([
  { id: 'markdown', label: 'Markdown (.md)', pro: false },
  { id: 'json', label: 'JSON (.json)', pro: false },
  { id: 'text', label: 'Plain text (.txt)', pro: false },
  { id: 'html', label: 'HTML - self-contained page', pro: true },
  { id: 'pdf', label: 'PDF', pro: true },
  { id: 'docx', label: 'Word document (.docx)', pro: true },
  { id: 'obsidian', label: 'Obsidian Markdown', pro: true },
  { id: 'csv', label: 'CSV - one row per message', pro: true },
  { id: 'jsonl', label: 'JSONL - fine-tuning dataset', pro: true },
]);

const AI_STUDIO_FREE_FORMATS = Object.freeze(
  AI_STUDIO_FORMATS.filter((f) => !f.pro).map((f) => f.id)
);

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
