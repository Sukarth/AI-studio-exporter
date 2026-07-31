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
(`attachments/…`), so **extract the ZIP before following links** — most PDF
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
for anything that failed. `manifest.json` is the same information for tooling —
fields documented in
[data-reference.md](data-reference.md#library-manifest).

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

A per-conversation export splits into multiple archives once buffered content
passes **256 MB** (measured before compression, since that is what predicts
memory pressure, so the finished files are smaller):

```
ai-studio-library-2026-07-31T06-40-38 (part 1 of 3).zip
ai-studio-library-2026-07-31T06-40-38 (part 2 of 3).zip
ai-studio-library-2026-07-31T06-40-38 (part 3 of 3).zip
```

Each volume is self-contained and carries its own `index.md` and
`manifest.json` covering just its own conversations. The failure list appears
only in part 1.

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

The timestamp is the export time in UTC, ISO 8601 with `:` and `.` replaced by
`-`, which sorts correctly in a file listing.
