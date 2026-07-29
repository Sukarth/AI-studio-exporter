/**
 * Decoder for AI Studio's internal MakerSuite RPC payloads.
 *
 * The endpoint speaks protobuf-JSON: messages arrive as positional arrays with
 * `null` in every unset slot, so all field access is by numeric index. The
 * index maps below were derived by observing live responses; they are the only
 * place in the codebase that knows the wire format.
 *
 * This is an undocumented internal API and Google can renumber these fields at
 * any time. Every read goes through the tolerant helpers at the top so a shape
 * change degrades to missing metadata rather than a thrown exception — the
 * caller decides whether the result is complete enough, and falls back to the
 * DOM scraper when it isn't.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});
  const { emptyConversation, makeTurn, recomputeStats } = AISE.model;

  /** Prompt message (the object at response[0]). */
  const PROMPT = {
    NAME: 0,          // "prompts/<driveId>"
    RUN_SETTINGS: 3,
    METADATA: 4,
    CHUNKED: 13,      // [turns[], pendingInputs[]]
  };

  // Verified against the live UI: a prompt showing Temperature 1 in AI Studio
  // carries 1 at index 0 and 0.95 at index 4, so index 4 is topP — not
  // temperature, which the two values being close makes easy to transpose.
  const RUN_SETTINGS = {
    TEMPERATURE: 0,
    MODEL: 2,
    TOP_P: 4,
    TOP_K: 5,
    MAX_OUTPUT_TOKENS: 6,
    SAFETY: 7,
  };

  const METADATA = {
    TITLE: 0,
    OWNER: 2,
    MODIFIED: 4,      // [[epochSeconds, nanos], owner]
    KEY_VALUES: 11,   // [["promptType","CHUNKED_PROMPT"], ...]
  };

  const TURN = {
    TEXT: 0,
    DRIVE_REF_ALT: 1, // [driveId] — seen rarely
    DRIVE_REF: 3,     // [driveId] — attachment reference
    ROLE: 8,          // "user" | "model"
    // 1 on a model turn that is the answer; unset on one that is reasoning.
    // Note the polarity: this marks answers, not thoughts.
    ANSWER_FLAG: 16,
    TOKEN_COUNT: 18,
    INLINE_FILE: 23,  // [nameOrMime, base64Data]
    PARTS: 29,        // streamed chunks, each [_, text, ...]
    TIMESTAMP: 32,    // [epochSeconds, nanos]
  };

  const PART_TEXT = 1;
  // 1 on a part that belongs to the model's reasoning rather than its answer.
  const PART_THOUGHT = 12;

  // --- tolerant accessors -------------------------------------------------
  // Every one of these returns a fallback rather than throwing, so a renumbered
  // field costs us that field and nothing else.

  const at = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined);
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const arr = (v) => (Array.isArray(v) ? v : []);

  /** Protobuf timestamps arrive as [seconds, nanos]; seconds may be a string. */
  function toEpochMs(ts) {
    if (!Array.isArray(ts)) return null;
    const seconds = Number(ts[0]);
    if (!Number.isFinite(seconds)) return null;
    return Math.round(seconds * 1000 + (Number(ts[1]) || 0) / 1e6);
  }

  function decodeConfig(runSettings) {
    if (!Array.isArray(runSettings)) return null;
    const safety = arr(at(runSettings, RUN_SETTINGS.SAFETY))
      .filter(Array.isArray)
      .map((s) => ({ category: num(s[2]), threshold: num(s[3]) }));

    return {
      model: str(at(runSettings, RUN_SETTINGS.MODEL)) || null,
      temperature: num(at(runSettings, RUN_SETTINGS.TEMPERATURE)),
      topP: num(at(runSettings, RUN_SETTINGS.TOP_P)),
      topK: num(at(runSettings, RUN_SETTINGS.TOP_K)),
      maxOutputTokens: num(at(runSettings, RUN_SETTINGS.MAX_OUTPUT_TOKENS)),
      safetySettings: safety,
    };
  }

  /**
   * A turn's visible text is either the flat string at TEXT, or — when the
   * response was streamed — the concatenation of its chunks. Prefer the flat
   * string and fall back to joining parts, since the two are redundant.
   */
  function decodeText(rawTurn) {
    const flat = str(at(rawTurn, TURN.TEXT));
    if (flat) return flat;
    return arr(at(rawTurn, TURN.PARTS))
      .map((p) => str(at(p, PART_TEXT)))
      .join('');
  }

  /**
   * Media on a turn shows up two ways: a bare Drive id we can resolve later, or
   * bytes the API inlined directly. Both are emitted as parts; the caller can
   * fetch by driveId for the former.
   */
  function decodeMedia(rawTurn) {
    const parts = [];

    const inline = at(rawTurn, TURN.INLINE_FILE);
    if (Array.isArray(inline) && typeof inline[1] === 'string') {
      const label = str(inline[0]);
      const isMime = label.includes('/');
      parts.push({
        type: isMime && label.startsWith('image/') ? 'image' : 'file',
        name: isMime ? null : label || null,
        mimeType: isMime ? label : null,
        driveId: null,
        dataBase64: inline[1],
        byteLength: Math.floor((inline[1].length * 3) / 4),
      });
    }

    for (const slot of [TURN.DRIVE_REF, TURN.DRIVE_REF_ALT]) {
      const ref = at(rawTurn, slot);
      const driveId = Array.isArray(ref) ? str(ref[0]) : '';
      if (driveId && !parts.some((p) => p.driveId === driveId)) {
        parts.push({
          type: 'file',
          name: null,
          mimeType: null,
          driveId,
          dataBase64: null,
          byteLength: null,
        });
      }
    }

    return parts;
  }

  /**
   * Decide whether a model turn holds reasoning or the answer.
   *
   * Prefer the part-level marker, which states it directly: a turn whose parts
   * are all flagged as thoughts is reasoning. Fall back to the turn-level flag,
   * whose polarity is the trap here — it is set on answers, so its absence
   * means reasoning. Reading it as an isThought flag inverts every model turn
   * and files answers under reasoning.
   */
  function isThoughtTurn(rawTurn, role) {
    if (role !== 'model') return false;

    const parts = arr(at(rawTurn, TURN.PARTS));
    if (parts.length) return parts.every((part) => at(part, PART_THOUGHT) === 1);

    return at(rawTurn, TURN.ANSWER_FLAG) !== 1;
  }

  function decodeTurn(rawTurn) {
    const role = str(at(rawTurn, TURN.ROLE)) === 'model' ? 'model' : 'user';
    const turn = makeTurn(role, decodeText(rawTurn), {
      isThought: isThoughtTurn(rawTurn, role),
      tokenCount: num(at(rawTurn, TURN.TOKEN_COUNT)),
      timestamp: toEpochMs(at(rawTurn, TURN.TIMESTAMP)),
    });
    turn.parts = decodeMedia(rawTurn);
    return turn;
  }

  /** Strip the "prompts/" resource prefix to get the bare Drive id. */
  function bareId(name) {
    return str(name).replace(/^prompts\//, '');
  }

  /**
   * Turn a ResolveDriveResource response into a Conversation.
   * Throws only when the payload is unrecognisable, which is the caller's
   * signal to fall back to DOM scraping.
   */
  function decodeConversation(response) {
    const prompt = at(response, 0);
    if (!Array.isArray(prompt)) {
      throw new Error('Unexpected ResolveDriveResource payload: no prompt message');
    }

    const id = bareId(at(prompt, PROMPT.NAME));
    const metadata = at(prompt, PROMPT.METADATA);
    const conversation = emptyConversation(id, 'api');

    conversation.title = str(at(metadata, METADATA.TITLE)) || conversation.title;
    conversation.modifiedAt = toEpochMs(at(arr(at(metadata, METADATA.MODIFIED)), 0));
    conversation.config = decodeConfig(at(prompt, PROMPT.RUN_SETTINGS));

    const rawTurns = arr(at(arr(at(prompt, PROMPT.CHUNKED)), 0));
    conversation.turns = rawTurns
      .map(decodeTurn)
      // A turn with neither text nor media is a placeholder (e.g. the empty
      // draft row AI Studio keeps at the end); it carries nothing to export.
      .filter((t) => t.text.trim() || t.parts.length);

    return recomputeStats(conversation);
  }

  /**
   * Turn a ListPrompts response into a library index plus the token for the
   * next page (null when the listing is exhausted).
   */
  function decodePromptList(response) {
    const items = arr(at(response, 0)).map((entry) => {
      const metadata = at(entry, PROMPT.METADATA);
      const keyValues = Object.fromEntries(
        arr(at(metadata, METADATA.KEY_VALUES)).filter(Array.isArray).map((kv) => [kv[0], kv[1]])
      );
      return {
        id: bareId(at(entry, PROMPT.NAME)),
        title: str(at(metadata, METADATA.TITLE)) || 'Untitled Conversation',
        modifiedAt: toEpochMs(at(arr(at(metadata, METADATA.MODIFIED)), 0)),
        promptType: keyValues.promptType || null,
        hasImages: keyValues.hasImages === 'true',
      };
    });

    return { items, nextPageToken: str(at(response, 1)) || null };
  }

  AISE.decode = { decodeConversation, decodePromptList, toEpochMs, bareId, TURN, PROMPT };
})(typeof globalThis !== 'undefined' ? globalThis : self);
