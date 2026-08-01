/**
 * Normalized conversation model.
 *
 * Both extractors (the API path in src/api/ and the legacy DOM scraper
 * in content.js) produce this shape, and every formatter consumes it. Adding a
 * format means writing one function against this; it never means touching an
 * extractor.
 *
 * Fields the DOM path cannot populate are simply left null, so formatters must
 * treat everything outside `turns` as optional. `source` tells you which path
 * produced the object, which is what the UI uses to warn about reduced fidelity.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  /**
   * @typedef {Object} Part
   * @property {'text'|'image'|'file'} type
   * @property {string} [text]        - for type 'text'
   * @property {string} [name]        - original filename, when known
   * @property {string} [mimeType]
   * @property {string} [driveId]     - Drive resource id, when the turn refs one
   * @property {string} [dataBase64]  - raw bytes, when the API inlined them
   * @property {number} [byteLength]
   */

  /**
   * @typedef {Object} Turn
   * @property {'user'|'model'} role
   * @property {boolean} isThought    - model reasoning rather than the answer
   * @property {string} text
   * @property {Part[]} parts
   * @property {number|null} tokenCount
   * @property {number|null} timestamp - epoch ms
   */

  /**
   * @typedef {Object} Conversation
   * @property {string} id            - bare Drive id, no "prompts/" prefix
   * @property {string} title
   * @property {string} url
   * @property {'api'|'dom'} source
   * @property {number} exportedAt
   * @property {number|null} modifiedAt
   * @property {ModelConfig|null} config
   * @property {string|null} systemInstruction
   * @property {Turn[]} turns
   * @property {Stats} stats
   */

  /**
   * @typedef {Object} ModelConfig
   * @property {string|null} model
   * @property {number|null} temperature
   * @property {number|null} topP
   * @property {number|null} topK
   * @property {number|null} maxOutputTokens
   * @property {Array<{category: number, threshold: number}>} safetySettings
   */

  const PROMPT_URL = 'https://aistudio.google.com/prompts/';

  function emptyConversation(id, source) {
    return {
      id,
      title: 'Untitled Conversation',
      url: id ? PROMPT_URL + id : '',
      source,
      exportedAt: Date.now(),
      modifiedAt: null,
      config: null,
      systemInstruction: null,
      turns: [],
      stats: { turnCount: 0, userTurns: 0, modelTurns: 0, thoughtTurns: 0, totalTokens: null, attachments: 0 },
    };
  }

  function makeTurn(role, text, extra) {
    return Object.assign(
      {
        role,
        isThought: false,
        text: text || '',
        parts: [],
        excludedAttachments: 0,
        tokenCount: null,
        timestamp: null,
      },
      extra || {}
    );
  }

  /**
   * Recompute `stats` from `turns`. Token totals stay null unless at least one
   * turn reported a count; a zero would imply we measured and got nothing.
   */
  function recomputeStats(conversation) {
    const turns = conversation.turns || [];
    let totalTokens = null;
    let attachments = 0;

    for (const turn of turns) {
      if (typeof turn.tokenCount === 'number') {
        totalTokens = (totalTokens || 0) + turn.tokenCount;
      }
      attachments += turn.parts.filter((p) => p.type === 'image' || p.type === 'file').length;
    }

    conversation.stats = {
      turnCount: turns.length,
      userTurns: turns.filter((t) => t.role === 'user').length,
      modelTurns: turns.filter((t) => t.role === 'model' && !t.isThought).length,
      thoughtTurns: turns.filter((t) => t.isThought).length,
      totalTokens,
      attachments,
    };
    return conversation;
  }

  /** Whether a part survives the user's attachment settings. */
  function partIncluded(part, settings) {
    if (part.type === 'image') return !!settings.scrapeImages;
    if (part.type === 'file') return !!settings.scrapeAttachments;
    return true;
  }

  /**
   * AI Studio files each attachment as its own turn, so a message with three
   * images arrives as four turns: three attachment-only and one carrying the
   * text. Rendered literally that is three headed blocks with nothing under
   * them, which is what a real export looked like.
   *
   * Fold each run of attachment-only turns into the same-role turn that follows
   * it, summing token counts, so the export matches what the user actually sent.
   */
  function condenseAttachmentTurns(conversation) {
    const turns = conversation.turns;
    const out = [];

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const attachmentOnly = !turn.text.trim() && (turn.parts.length > 0 || turn.excludedAttachments > 0);

      // A trailing run with no message after it stays as it is: there is
      // nothing to merge into, and dropping it would lose the attachment.
      const next = turns[i + 1];
      if (!attachmentOnly || !next || next.role !== turn.role || next.isThought !== turn.isThought) {
        out.push(turn);
        continue;
      }

      next.parts = turn.parts.concat(next.parts);
      next.excludedAttachments = (turn.excludedAttachments || 0) + (next.excludedAttachments || 0);
      if (typeof turn.tokenCount === 'number') {
        next.tokenCount = (next.tokenCount || 0) + turn.tokenCount;
      }
      // The attachment was sent first, so its timestamp is the message's.
      if (turn.timestamp && (!next.timestamp || turn.timestamp < next.timestamp)) {
        next.timestamp = turn.timestamp;
      }
    }

    conversation.turns = out;
    return conversation;
  }

  /**
   * Drop content the user opted out of, then refresh stats so downstream
   * formatters never report on turns that are no longer present.
   *
   * Excluded attachments are counted rather than forgotten. Removing them
   * outright left messages that were nothing but a heading and a token count,
   * which reads as a bug; `excludedAttachments` lets a formatter say what was
   * left out instead.
   */
  function applySettings(conversation, settings) {
    if (!settings) return conversation;

    if (!settings.scrapeReasoning) {
      conversation.turns = conversation.turns.filter((t) => !t.isThought);
    }
    if (!settings.includeSystemInstruction) {
      conversation.systemInstruction = null;
    }
    if (!settings.includeModelConfig) {
      conversation.config = null;
    }
    if (!settings.includeTimestamps) {
      conversation.turns.forEach((t) => { t.timestamp = null; });
    }
    if (!settings.includeTokenCounts) {
      conversation.turns.forEach((t) => { t.tokenCount = null; });
    }

    for (const turn of conversation.turns) {
      const kept = turn.parts.filter((p) => partIncluded(p, settings));
      turn.excludedAttachments = (turn.excludedAttachments || 0) + (turn.parts.length - kept.length);
      turn.parts = kept;
    }

    if (settings.condenseAttachments !== false) condenseAttachmentTurns(conversation);

    return recomputeStats(conversation);
  }

  AISE.model = {
    emptyConversation,
    makeTurn,
    recomputeStats,
    applySettings,
    condenseAttachmentTurns,
    PROMPT_URL,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
