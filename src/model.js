/**
 * Normalized conversation model.
 *
 * Both extractors — the API path (src/api/) and the legacy DOM scraper
 * (content.js) — produce this shape, and every formatter consumes it. Adding a
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
      { role, isThought: false, text: text || '', parts: [], tokenCount: null, timestamp: null },
      extra || {}
    );
  }

  /**
   * Recompute `stats` from `turns`. Token totals stay null unless at least one
   * turn reported a count — a zero would imply we measured and got nothing.
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

  /**
   * Drop content the user opted out of, then refresh stats so downstream
   * formatters never report on turns that are no longer present.
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
    if (!settings.scrapeImages) {
      conversation.turns.forEach((t) => { t.parts = t.parts.filter((p) => p.type !== 'image'); });
    }
    if (!settings.scrapeAttachments) {
      conversation.turns.forEach((t) => { t.parts = t.parts.filter((p) => p.type !== 'file'); });
    }

    return recomputeStats(conversation);
  }

  AISE.model = { emptyConversation, makeTurn, recomputeStats, applySettings, PROMPT_URL };
})(typeof globalThis !== 'undefined' ? globalThis : self);
