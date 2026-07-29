/**
 * CSV export — one row per turn, for analysis in a spreadsheet.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  const COLUMNS = [
    'conversation_id', 'conversation_title', 'turn_index', 'role', 'is_reasoning',
    'timestamp', 'token_count', 'attachments', 'text',
  ];

  /**
   * RFC 4180 quoting. Every field is quoted rather than only those that need
   * it, which sidesteps the leading-separator and trailing-space edge cases.
   *
   * The leading apostrophe guards against CSV injection: a cell starting =, +,
   * - or @ is executed as a formula when the file is opened in Excel or Sheets,
   * and message text is attacker-influenced.
   */
  function cell(value) {
    if (value === null || value === undefined) return '""';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function render(conversation, settings) {
    const rows = [COLUMNS.map(cell).join(',')];

    conversation.turns.forEach((turn, index) => {
      rows.push([
        conversation.id,
        conversation.title,
        index,
        turn.role,
        turn.isThought ? 'true' : 'false',
        settings.includeTimestamps && turn.timestamp ? new Date(turn.timestamp).toISOString() : '',
        settings.includeTokenCounts && turn.tokenCount !== null ? turn.tokenCount : '',
        turn.parts.map((p) => p.name || p.driveId || 'attachment').join('; '),
        turn.text,
      ].map(cell).join(','));
    });

    // CRLF per RFC 4180, and a BOM so Excel reads UTF-8 rather than guessing
    // the local codepage and mangling every non-ASCII character.
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  AISE.formats = AISE.formats || {};
  AISE.formats.csv = {
    id: 'csv',
    label: 'CSV — one row per message (.csv)',
    extension: 'csv',
    mimeType: 'text/csv',
    pro: true,
    bundlesAssets: false,
    concatenable: true,
    render,
    COLUMNS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
