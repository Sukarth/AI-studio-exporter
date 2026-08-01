# AI Studio Exporter: format documentation

What each export format contains, what every field means, and how the settings
change the output.

| Document | Read it when |
| --- | --- |
| [Formats](formats.md) | Choosing a format, or wondering what one looks like |
| [Data reference](data-reference.md) | Parsing a JSON, JSONL or CSV export in code |
| [What you download](archives.md) | Working out where the files inside a `.zip` came from |
| [Settings](settings.md) | A field is missing and you want to know which toggle removed it |
| [Toolbar badge](badges.md) | There is a mark on the extension icon and you want to know what it means |

## Pick a format in ten seconds

| You want to… | Use |
| --- | --- |
| Read the conversation later, in anything | **Markdown** |
| Paste into something that rejects markup | **Plain text** |
| Parse it, re-import it, or build on it | **JSON** |
| Send it to someone who will just open it | **HTML** or **PDF** |
| Edit or comment on it | **Word** |
| File it in a vault | **Obsidian Markdown** |
| Chart it, pivot it, count things | **CSV** |
| Fine-tune a model on it | **JSONL** |

Markdown, plain text and JSON are free. The rest are Pro.

## The shape everything is built from

Every format is rendered from one normalised object, so they all describe the
same conversation and differ only in presentation. Two properties of that model
explain most of what looks odd in an export:

**A conversation is a flat list of turns, not a tree.** Each turn has a `role`
(`user` or `model`) and an `isThought` flag. Reasoning is a `model` turn with
`isThought: true`; it is not nested inside the answer it precedes, because AI
Studio does not store it that way.

**Attachments arrive as their own turns.** AI Studio files each uploaded image
or document as a separate message, so a question sent with three screenshots is
four turns: three carrying only a file, then one carrying the text. The
`condenseAttachments` setting (on by default) folds those back into the message
they were sent with. See [settings guide](settings.md#condense-attachments).

## Conventions across every format

- **Timestamps** are UTC. Structured formats (JSON, JSONL, CSV) use ISO 8601
  (`2025-06-15T12:20:00.000Z`); human-facing ones use `2025-06-15 12:20:00 UTC`.
- **Token counts** are AI Studio's own numbers, not a re-count. They are absent
  rather than zero when AI Studio did not report one.
- **Attachment paths** are relative to the export root, always
  `attachments/<filename>`, so a document and its files move together.
- **Nothing is silently dropped.** If a setting excludes an attachment, the
  message still says how many were left out. See
  [`excludedAttachments`](data-reference.md#excludedattachments).

## Something looks wrong

| Symptom | Cause |
| --- | --- |
| Non-Latin text is `?` in the PDF | The standard PDF fonts are Latin-only. Export HTML and print to PDF from your browser. |
| A message shows a file name but no file | The bytes could not be fetched. The name is kept so the record stays honest. |
| A message has no text, only attachments | AI Studio stored it that way and `condenseAttachments` had nothing to fold it into (usually the last message in a conversation). |
| Fields are missing everywhere | Either a setting is off ([settings guide](settings.md)) or the export came from the DOM fallback, which cannot see metadata. Check `source` in the JSON. |
