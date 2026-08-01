# Data reference

Field-level documentation for the machine-readable formats. If you are writing
code against an export, this is the page you want.

- [JSON](#json)
- [JSONL](#jsonl)
- [CSV](#csv)
- [Library manifest](#library-manifest)
- [Value glossary](#value-glossary)

---

## JSON

`schemaVersion` is `1`. A breaking change to any field below bumps it; adding
an optional field does not.

**Fields marked _optional_ are omitted entirely, not set to `null`,** when the
setting that controls them is off. Read them with a default. The distinction is
deliberate: `undefined` means "not exported", `null` means "AI Studio had no
value".

### Top level

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | number | Currently `1`. |
| `exporter` | string | Always `"ai-studio-exporter"`. Use it to recognise the file. |
| `id` | string | The AI Studio prompt id (a bare Drive id, no `prompts/` prefix). |
| `title` | string | Conversation title. `"Untitled Conversation"` when AI Studio has none. |
| `url` | string \| _optional_ | Canonical AI Studio URL. Omitted unless `includeSourceUrl`. |
| `source` | `"api"` \| `"dom"` | Which extractor produced this. See [source](#source). |
| `exportedAt` | ISO 8601 string | When the export ran. |
| `modifiedAt` | ISO 8601 string \| null | Last modification per AI Studio. `null` if unknown. |
| `config` | object \| null \| _optional_ | Model settings. Omitted unless `includeModelConfig`. |
| `systemInstruction` | string \| null \| _optional_ | Omitted unless `includeSystemInstruction`. |
| `stats` | object | See [stats](#stats). |
| `turns` | array | The conversation. See [turns](#turns). |

### `config`

`null` when AI Studio reported no configuration; individual fields are `null`
when that one value was absent.

| Field | Type | Notes |
| --- | --- | --- |
| `model` | string \| null | Prefixed, e.g. `"models/gemini-3-pro"`. Human-facing formats strip `models/`. |
| `temperature` | number \| null | |
| `topP` | number \| null | |
| `topK` | number \| null | |
| `maxOutputTokens` | number \| null | |
| `safetySettings` | array | `[{category: number, threshold: number}]`, AI Studio's own numeric enums, passed through unmapped. |

### `stats`

Recomputed **after** settings are applied, so it describes what is in the file,
not what the conversation originally held. Exclude reasoning and
`thoughtTurns` is `0`.

| Field | Type | Notes |
| --- | --- | --- |
| `turnCount` | number | Total turns in this export. |
| `userTurns` | number | |
| `modelTurns` | number | Answers only; excludes reasoning. |
| `thoughtTurns` | number | Reasoning turns. |
| `totalTokens` | number \| null | Sum of per-turn counts. `null` if AI Studio reported none. |
| `attachments` | number | Attachments actually present in the export. |

### `turns`

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `"user"` \| `"model"` | |
| `isThought` | boolean | `true` marks reasoning. Always a `model` turn. |
| `text` | string | Message body, as Markdown. May be `""` on an attachment-only turn. |
| `tokenCount` | number \| null \| _optional_ | Omitted unless `includeTokenCounts`. |
| `excludedAttachments` | number \| _optional_ | See [below](#excludedattachments). Omitted when `0`. |
| `timestamp` | ISO 8601 string \| _optional_ | Omitted unless `includeTimestamps`, or when AI Studio reported none. |
| `parts` | array \| _optional_ | Attachments. Omitted when the turn has none. |

#### `parts[]`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"image"` \| `"file"` | Decided by MIME type, not by extension. |
| `name` | string \| undefined | Original filename, when AI Studio knew one. |
| `mimeType` | string \| undefined | As reported by Drive. |
| `driveId` | string \| undefined | Drive resource id. Stable; useful for deduplicating across exports. |
| `byteLength` | number \| undefined | Size of the retrieved file. |
| `path` | string \| null | Path inside the archive, e.g. `"attachments/screenshot.png"`. **`null` means the bytes could not be fetched** (the record of the attachment is kept, but no file exists). |

#### `excludedAttachments`

The number of attachments this turn had that are **not** in the export, because
`scrapeImages` or `scrapeAttachments` excluded them.

It exists because removing them outright left messages that were nothing but a
heading and a token count, which reads as a bug. If you are treating an export
as a dataset, check this field: a turn with `excludedAttachments > 0` is
incomplete, and you cannot tell that from `parts` alone.

---

## JSONL

One JSON object per line. No wrapper array, no trailing comma, `\n`-terminated.

```json
{"messages": [{"role": "system", "content": "…"}, {"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]}
```

| Field | Notes |
| --- | --- |
| `messages[].role` | `"system"`, `"user"` or `"assistant"`. The model's `"model"` role is renamed to `"assistant"` to match the fine-tuning convention. |
| `messages[].content` | String. Attachments appear as a leading `[attachment: name]` line, then a blank line, then the message text. |

`system` appears only if the conversation had a system instruction. Note that
it is included **whenever one exists**; the `includeSystemInstruction` setting
strips it upstream, so turning that off removes it here too.

Line-count caveat: **the number of lines is not the number of conversations you
selected.** A conversation with no assistant reply produces no line at all. The
export's own summary reports what actually landed in the file.

### `jsonlIncludeReasoning`

Off by default. When off, reasoning turns are skipped entirely. When on, each
becomes an `assistant` message and (because it is adjacent to the real answer,
which is also `assistant`) is merged into it with a blank line between.

---

## CSV

One row per turn. UTF-8 with a BOM, CRLF line endings, every field quoted.

| Column | Notes |
| --- | --- |
| `conversation_id` | AI Studio prompt id. Repeated on every row of the conversation. |
| `conversation_title` | Repeated on every row. |
| `turn_index` | 0-based, within this conversation. In a combined library export, indices restart per conversation; group by `conversation_id` before ordering. |
| `role` | `user` or `model`. |
| `is_reasoning` | `true` or `false` as literal text. |
| `timestamp` | ISO 8601, or empty if unavailable or `includeTimestamps` is off. |
| `token_count` | Integer, or empty. |
| `attachments` | Filenames joined by `"; "`. Empty when there are none. Falls back to the Drive id, then to `attachment`, when the name is unknown. |
| `text` | The full message body, newlines and all, inside the quoted field. |

**Formula-injection guard:** any cell whose text begins `=`, `+`, `-`, `@`, tab
or CR is prefixed with a single apostrophe. Strip a leading `'` if you are
parsing programmatically and the original value matters.

---

## Library manifest

A whole-library export to a per-conversation format writes two extra files at
the root of each archive.

**`index.md`** is a human-readable listing linking to every conversation, plus
any failures.

**`manifest.json`**:

```json
{
  "exporter": "ai-studio-exporter",
  "exportedAt": "2026-07-31T06:40:38.000Z",
  "format": "markdown",
  "volume": 1,
  "volumeCount": 2,
  "library": [
    {
      "title": "How does the RPC auth work?",
      "path": "how-does-the-rpc-auth-work/conversation.md",
      "modifiedAt": 1750000000000,
      "turnCount": 5,
      "volume": 1
    },
    {
      "title": "Design Review",
      "path": "design-review/conversation.md",
      "modifiedAt": 1749000000000,
      "turnCount": 210,
      "volume": 2
    }
  ],
  "conversations": [
    {
      "title": "How does the RPC auth work?",
      "path": "how-does-the-rpc-auth-work/conversation.md",
      "modifiedAt": 1750000000000,
      "turnCount": 5,
      "volume": 1
    }
  ],
  "failures": []
}
```

| Field | Notes |
| --- | --- |
| `format` | The format id, matching the ids in [format guide](formats.md). |
| `volume` / `volumeCount` | Archives are split near 256 MB. See [what you download](archives.md#large-libraries). |
| `library` | **Every** conversation in the export, wherever it ended up. Present even when there is only one archive, so a consumer never has to special-case that. |
| `conversations` | Only what this archive holds. `path` resolves inside it; a path from `library` may not. |
| `*.volume` | Which part holds that conversation (always `1` when the export was not split). |
| `*.modifiedAt` | Epoch **milliseconds** here, not ISO (this file is written by the batch layer, not the JSON formatter). |
| `failures` | `[{id, title, error}]`. Repeated in every part: a failure list that exists in one archive out of three is one most people never see. |

---

## Value glossary

### `source`

`"api"` is read from AI Studio's own backend. Full fidelity: token counts,
timestamps, model configuration, system instruction, and attachment bytes.

`"dom"` is scraped from the rendered page, used when the API path is
unavailable. Only what the page displays: no token counts, no model config, no
system instruction, and attachments limited to what was rendered. If fields are
missing across the board, check this first.

### `isThought`

Marks a model turn as reasoning rather than the answer. Reasoning is a sibling
of the answer in the turn list, not a child of it, because that is how AI Studio
stores it. A question typically produces two `model` turns in sequence, the
first with `isThought: true`.

### Token counts

AI Studio's own numbers, passed through unmodified; they are not a re-count, and not
comparable to a tokenizer you run yourself. A turn with no reported count is
`null`, never `0`.

When `condenseAttachments` folds attachment turns into a message, their token
counts are **summed** into the surviving turn, so a conversation's total is
unchanged by the setting.

### Attachment `type`

`image` or `file`, decided from the MIME type rather than the extension. This
is what `scrapeImages` and `scrapeAttachments` filter on, and what decides
whether Markdown and HTML embed the file inline or link to it.
