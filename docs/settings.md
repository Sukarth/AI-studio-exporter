# Settings

What each setting changes, and which formats it changes. All of them are in the
extension's options page.

Settings are applied to the conversation **before** any formatter runs, so they
affect every format identically unless noted. Statistics are recomputed
afterwards: exclude reasoning and the export's own message count drops to match.

---

## Content

### Reasoning (`scrapeReasoning`) — on

Include the model's thinking, not just its answers.

Off removes those turns entirely. On, each format handles them differently:

| Format | How reasoning appears |
| --- | --- |
| Markdown, plain text | A labelled turn, inline |
| HTML | A `<details>` block, **collapsed by default** |
| Obsidian | A `> [!note]-` callout, collapsed by default |
| PDF, Word | An amber-tinted block with recoloured body text |
| JSON, CSV | A turn with `isThought: true` / `is_reasoning: true` |
| JSONL | **Dropped**, unless `jsonlIncludeReasoning` is on — see [formats.md](formats.md#jsonl) |

### Images (`scrapeImages`) — on

### Other attachments (`scrapeAttachments`) — on

Whether to download image attachments, and whether to download everything else.
Split because "keep the screenshots, skip the 40 MB of CSVs" is a common want.

The two are decided by MIME type, not extension. Anything excluded is **counted,
not forgotten**: the message still says `2 attachments not included in export`,
and the JSON carries `excludedAttachments: 2`. Without that, a message whose
only content was an excluded file renders as a bare heading, which reads as a
bug.

Turning both off also skips the downloads, which is the fastest way to export a
large conversation.

### Condense attachments (`condenseAttachments`) — on {#condense-attachments}

AI Studio files each attachment as its own message, so a question sent with
three screenshots is stored as four messages: three carrying only a file, then
one carrying the text.

**On**, each run of attachment-only messages is folded into the message it was
sent with — matching what you actually did. Token counts are summed and the
earliest timestamp wins, so no numbers change.

**Off**, AI Studio's own structure is preserved. Useful if you are reconciling
an export against the API, and misleading otherwise: it produces headed blocks
with nothing under them.

A trailing attachment with no message after it is never folded — there is
nothing to fold it into, and dropping it would lose the file.

---

## Metadata

These control fields AI Studio's backend exposes but its page does not render.
All default on; each is individually switchable because some people want a
clean transcript and nothing else.

| Setting | Adds | Removed from |
| --- | --- | --- |
| `includeModelConfig` | Model name, temperature, top P, top K, max output tokens | Header of every format; `config` in JSON; frontmatter in Obsidian |
| `includeSystemInstruction` | The system instruction | Its own section in every format; `systemInstruction` in JSON; **the `system` message in JSONL** |
| `includeTimestamps` | Per-message and last-modified times | Message subtitles; `timestamp` in JSON; the `timestamp` column in CSV |
| `includeTokenCounts` | Per-message and total token counts | Message subtitles; `tokenCount` in JSON; the `token_count` column in CSV |
| `includeSourceUrl` | Link back to the AI Studio conversation | Header; `url` in JSON; `source` in Obsidian frontmatter |

In JSON, a field switched off is **absent**, not `null` — `null` is reserved for
"AI Studio had no value". See
[data-reference.md](data-reference.md#json).

CSV always emits all nine columns; a disabled field leaves its cell empty
rather than dropping the column, so the file stays parseable.

---

## Format-specific

### `jsonlIncludeReasoning` — off

JSONL only. Off, reasoning turns are dropped from the dataset — training on a
model's private thinking as if it were the reply teaches it to emit thinking as
output. On, each reasoning turn becomes an `assistant` message and merges into
the answer beside it.

---

## Other

### `defaultFormat` — `markdown`

Which format the popup preselects.

### DOM fallback only

These four apply solely when the API path is unavailable and the page has to be
scraped instead. A normal export ignores them, because the API returns the real
file rather than what the page happened to render.

| Setting | Default | Effect |
| --- | --- | --- |
| `scrapeAttachmentTitle` | on | Record the file name shown on the page |
| `scrapeAttachmentSize` | on | Record the file size shown on the page |
| `scrapeAttachmentPreview` | on | Save the page's thumbnail image |
| `loadDelay` | 700 ms | How long to wait for content to render while scrolling |

---

## What settings cannot fix

Some things are limits of the format, not of a toggle:

| | |
| --- | --- |
| Non-Latin text becomes `?` in the PDF | The standard PDF fonts are Latin-only. Export HTML and print to PDF from your browser. |
| An attachment shows a name but no file | The bytes could not be fetched from Drive. `path` is `null` in the JSON. |
| Everything metadata-ish is missing at once | The export used the DOM fallback. Check `source` in the JSON — see [data-reference.md](data-reference.md#source). |
