# Formats

Nine formats, all rendered from the same conversation model. This page covers
what each one looks like and what it is good at. For field-level detail on the
machine-readable three, see [data reference](data-reference.md).

| Format | Extension | Pro | Ships attachments | Combines in a library export |
| --- | --- | --- | --- | --- |
| [Markdown](#markdown) | `.md` | Free | yes | one folder per conversation |
| [Plain text](#plain-text) | `.txt` | Free | yes | one folder per conversation |
| [JSON](#json) | `.json` | Free | yes | one folder per conversation |
| [HTML](#html) | `.html` | Pro | yes | one folder per conversation |
| [PDF](#pdf) | `.pdf` | Pro | yes | one folder per conversation |
| [Word](#word) | `.docx` | Pro | yes | one folder per conversation |
| [Obsidian](#obsidian-markdown) | `.md` | Pro | yes | one folder per conversation |
| [CSV](#csv) | `.csv` | Pro | no | **one combined file** |
| [JSONL](#jsonl) | `.jsonl` | Pro | no | **one combined file** |

"Ships attachments" means a conversation with files downloads as a `.zip`
holding the document plus an `attachments/` folder. A conversation with no
files downloads as a single bare document (see [what you download](archives.md)).

---

## Markdown

The default. Message bodies are written **verbatim**, never escaped: what AI
Studio returns is already Markdown, and escaping it would defeat the point.

Each turn is preceded by an HTML comment delimiter:

```markdown
<!-- aise:turn role=user -->
## 👤 User

_2025-06-15 12:20:00 UTC · 18 tokens_

How does the RPC auth work?

<!-- aise:turn role=model thought=1 -->
## 🧠 Model (Reasoning)

...
```

The comments render as nothing but give tooling an unambiguous turn boundary.
That matters because message text can contain `## 👤 User` itself; it cannot
easily contain the delimiter by accident.

Attachments become links, images become embeds:

```markdown
![screenshot.png](attachments/screenshot.png)
📎 [network-log.har](attachments/network-log.har) _(1.4 MB)_
```

Link targets are percent-encoded, including `(`, `)`, `#` and `?`. A
parenthesis in a filename ends the link target early otherwise, which silently
broke links for any conversation containing two files of the same name.

**Good for:** anything. It reads well raw, renders everywhere, and diffs
cleanly in git.

## Plain text

The same transcript with no markup at all. Turns are separated by rules:

```
------------------------------------------------------------------------
USER  [2025-06-15 12:20:00 UTC | 18 tokens]
------------------------------------------------------------------------

[FILE: network-log.har -> attachments/network-log.har]
[IMAGE: screenshot.png -> attachments/screenshot.png]

How does the RPC auth work?
```

Attachments are named with their archive path, so the text file still tells you
where its files are. Message bodies keep whatever Markdown the model wrote;
this format does not strip it, it just adds none of its own.

**Good for:** pasting into ticket systems, email, or anything that mangles
Markdown.

## JSON

The lossless format. Everything the extractor captured is here except the raw
bytes, which live in `attachments/` and are referenced by path (this keeps the
JSON readable and stores each file once instead of base64'd twice).

```json
{
  "schemaVersion": 1,
  "exporter": "ai-studio-exporter",
  "id": "1AbCdEfGhIjKlMnOp",
  "title": "How does the RPC auth work?",
  "turns": [ … ]
}
```

Full field reference: [data reference](data-reference.md#json).

**Good for:** parsing, re-import, feeding another pipeline, or archiving
against future format changes.

## HTML

A single self-contained page with no external CSS, fonts or scripts, nothing
loaded from the network. Attachments are referenced from the sibling
`attachments/` folder, so keep the ZIP contents together.

- Markdown in message bodies is rendered: headings, fenced code, lists, tables,
  block quotes and rules.
- **Reasoning blocks are collapsed by default** as `<details>` elements. Click
  to expand; long thinking no longer buries the answer.
- Images are shown inline; other attachments are stacked links.
- Wide content (tables, long code lines) scrolls inside its own box rather than
  stretching the page.

**Good for:** sending to someone who should just be able to open it, or
printing to PDF from a browser when the conversation is not Latin-script.

## PDF

A paginated document, A4, with page numbers.

- **Each message sits on a tinted band with a coloured left rule**, so user,
  model and reasoning turns are distinguishable at a glance. Reasoning also
  recolours its body text, so the distinction survives greyscale printing.
- Markdown is rendered: headings, **bold**, *italic*, `inline code`, lists,
  block quotes and rules.
- Fenced code blocks and tables render in a shaded monospaced box.
- Attachments, the source URL, Markdown links and bare URLs are **clickable**.
  Attachment links are relative to the document, which sits beside
  `attachments/` inside the ZIP. Extract the archive before following them.

### The font limitation

PDF is generated with the standard PDF font set, which covers Latin only.
Smart quotes, dashes and ellipses are substituted cleanly; anything outside
Latin-1 (such as CJK, Devanagari, Kannada, Cyrillic, and emoji) becomes `?`.

The exporter detects this and warns before you download. **If your conversation
is not Latin-script, export HTML and print to PDF from your browser instead.**

## Word

A `.docx` that opens in Word, LibreOffice and Google Docs.

Same structure as the PDF: role-tinted paragraph shading with a coloured left
border, rendered Markdown, shaded monospaced code blocks, and hyperlinked
attachments. Unlike the PDF it has no font restriction, because Word substitutes
fonts itself.

**Good for:** anything that needs editing, tracked changes or comments.

## Obsidian Markdown

Plain Markdown differs from vault Markdown in three ways that matter, and this
format handles all three.

**YAML frontmatter**, so notes are queryable with Dataview:

```yaml
---
title: "How does the RPC auth work?"
exported: 2026-07-31T06:40:38.000Z
modified: 2025-06-15T15:06:40.000Z
source: https://aistudio.google.com/prompts/1AbCdEfGhIjKlMnOp
model: "gemini-3-pro"
temperature: 1
top_p: 0.95
top_k: 64
total_tokens: 882
messages: 5
tags: [ai-studio, conversation]
---
```

**Wikilinks** for attachments (`![[screenshot.png]]`), which resolve by vault
filename rather than by path, so the files work once they are anywhere in the
vault.

**Collapsible callouts** for reasoning (`> [!note]- 🧠 Reasoning`) and for the
system instruction, both collapsed by default.

Field meanings match [data reference](data-reference.md#json); the keys are
snake_case here because that is the Dataview convention.

## CSV

One row per message, RFC 4180, CRLF line endings, UTF-8 with a BOM so Excel
reads it as UTF-8 rather than guessing your local codepage.

Columns: [data reference](data-reference.md#csv).

Every field is quoted, whether or not it needs to be. Cells beginning `=`, `+`,
`-` or `@` are prefixed with an apostrophe; those are executed as formulas when
opened in Excel or Sheets, and message text is not something to trust.

A whole-library export produces **one combined CSV** with a single header row,
not one file per conversation.

**Good for:** counting, filtering and charting across many conversations.

## JSONL

One JSON object per line, in the `messages` format every major fine-tuning
stack accepts:

```json
{"messages":[{"role":"system","content":"…"},{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}
```

Three transformations happen here that do not happen anywhere else:

1. **Reasoning is dropped by default.** Training on a model's private thinking
   as if it were the reply teaches it to emit thinking as output. Enable
   `jsonlIncludeReasoning` if you specifically want reasoning traces.
2. **Consecutive same-role turns are merged**, joined by a blank line. Most
   fine-tuning APIs reject a conversation that goes user → user.
3. **Conversations with no assistant reply produce nothing.** They are not
   training examples.

Attachments are not shipped; they become an `[attachment: name]` line at the
top of the message content, so the text still reflects that a file was there.

A whole-library export produces **one combined `.jsonl` dataset**.

**Good for:** fine-tuning, evaluation sets, and anything that consumes chat
transcripts a line at a time.
