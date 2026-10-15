# What lands in your downloads folder

Three different layouts, depending on what you exported and to which format.

- [A single conversation](#a-single-conversation)
- [A whole library](#a-whole-library)
- [Filenames](#filenames)

---

## A single conversation

### No attachments → a bare file

```
How does the RPC auth work - 2026-07-31T06-40-38.md
```

There is nothing to bundle, and wrapping a lone `.md` in a ZIP is friction for
no benefit.

### With attachments → a ZIP

```
How does the RPC auth work - 2026-07-31T06-40-38.zip
├── conversation.md
└── attachments/
    ├── network-log.har
    └── screenshot of failing request.png
```

The document is always named `conversation.<ext>` inside the archive; the
archive itself carries the title. Every link in the document is relative
(`attachments/…`), so **extract the ZIP before following links**. Most PDF
readers and browsers will not resolve a relative link out of a compressed
archive.

CSV and JSONL never produce a ZIP. Neither format has a way to reference a file
on disk, so shipping the bytes beside them would be dead weight.

### Colliding filenames

Two attachments called `screenshot.png` become `screenshot.png` and
`screenshot (2).png`. The suffix goes before the extension so the file still
opens in the right application.

---

## A whole library

### Per-conversation formats → one folder each

Markdown, plain text, JSON, HTML, PDF, Word and Obsidian:

```
ai-studio-library-2026-07-31T06-40-38.zip
├── index.md
├── manifest.json
├── how-does-the-rpc-auth-work/
│   ├── conversation.md
│   └── attachments/
│       └── screenshot.png
└── another-conversation/
    └── conversation.md
```

`index.md` is a readable listing with a link to each conversation and a section
for anything that failed. `manifest.json` is the same information for tooling;
fields are documented in
[data reference](data-reference.md#library-manifest).

Folder names come from the conversation title. Two conversations with the same
title get the second one's id appended: `my-notes (1AbCdE)`.

### Combined formats → one file

CSV and JSONL produce a single file, not an archive:

```
ai-studio-library-2026-07-31T06-40-38.csv
ai-studio-library-2026-07-31T06-40-38.jsonl
```

The CSV's header row appears once at the top, not once per conversation.

### Large libraries

A per-conversation export splits into multiple archives once the next
conversation would push one past **256 MB** (measured before compression,
since that is what predicts memory pressure), so the finished files are smaller.

```
ai-studio-library-2026-07-31T06-40-38 (part 1 of 3).zip
ai-studio-library-2026-07-31T06-40-38 (part 2 of 3).zip
ai-studio-library-2026-07-31T06-40-38 (part 3 of 3).zip
```

A part only exceeds 256 MB when a single conversation does on its own, and that
conversation gets a part to itself rather than dragging its neighbours over the
limit with it.

**Every part lists the whole library.** Its `index.md` names every conversation
in the export: the ones in that archive are links, and the rest say which part
holds them.

```markdown
- [Weekly Notes](weekly-notes/conversation.md): 2026-07-14 · 42 messages
- Design Review: 2026-07-11 · 210 messages · **in part 3**
```

So whichever part you open, nothing in the export is unaccounted for and no
link points at a file that is not there. The failure list appears in every
part, for the same reason. `manifest.json` mirrors this: `conversations` is
what this archive holds, `library` is everything, with a `volume` number on
each entry.

Extract the parts side by side and they merge into one folder.

Chrome may ask once whether to allow multiple downloads.

### Partial failure

One unreadable conversation does not lose the rest. Failures are collected and
reported at the end, and recorded in `manifest.json` with the id, title and
error message. The export only aborts if **every** conversation failed.

---

## Filenames

Conversation titles are sanitised for the filesystem: characters illegal on
Windows are removed, the result is truncated to 120 characters, and names that
collide with Windows reserved device names (`CON`, `PRN`, `NUL`, `AUX`, `COM1`…)
get an `-export` suffix. An empty result falls back to `conversation`.

Inside an archive, names are shorter still, so that no path gets near Windows'
260-character limit. Windows Explorer refuses to open a ZIP at all if any one
path inside it reaches that limit, and extracting has to fit the destination
folder within it too.

| Name | Longest |
| --- | --- |
| A conversation's folder, in a library export | 60 characters, plus a short id if two titles collide |
| An attachment | 80 characters, extension kept, including any ` (2)` |

A name cut short loses the end of its text, never its extension, and never
ends in a space, dot or dash, which Windows would strip. The JSON export's
`name` field still records the attachment's full original name.

The timestamp is the export time in UTC, ISO 8601 with `:` and `.` replaced by
`-`, which sorts correctly in a file listing.
