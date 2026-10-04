# Changelog

All notable changes to the AI Studio Exporter extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - unreleased

A rewrite. Version 1 scrolled the page and read what it found; version 2 talks
to AI Studio's own API. A 200-message conversation took about two and a half
minutes of automated scrolling and now takes under a second.

### Added

- **API-based export.** `src/api/` speaks AI Studio's RPC interface. Because
  those endpoints are CORS-locked to the AI Studio origin, the transport runs
  in the page's MAIN world and is reached over `postMessage`.
- **Real attachments.** Files are fetched from Drive at full fidelity instead
  of being saved as page thumbnails. Google Docs, Sheets and Slides are
  converted on the way out, and only the types you asked for are downloaded.
- **Metadata the page never showed**: model, temperature, top-P, top-K, output
  limit, system instruction, per-message timestamps and token counts. Each has
  its own switch.
- **Six Pro formats**: HTML, PDF, Word, Obsidian, CSV and JSONL, alongside the
  free Markdown, JSON and plain text.
- **Whole-library export**, with an index, a manifest naming anything that
  failed, and automatic splitting for large libraries.
- **Scheduled backups**: daily, weekly or monthly, incremental, run from a
  background tab.
- **Licensing** through Polar. One payment, five browsers, and removing a
  licence releases the activation rather than stranding the seat.
- **A toolbar badge** reporting the state of a run, documented in
  [docs/badges.md](docs/badges.md). It is the only way an unattended scheduled
  backup can tell you it failed.
- **A design system**, Graphite/azure, in `theme.css`, with a light theme and a
  `system`/`dark`/`light` setting covering the popup, the settings page, its
  dialogs and the overlay drawn over AI Studio.
- **Documentation** under [docs/](docs/README.md): every format, every JSON,
  JSONL and CSV field, what lands in a `.zip`, and what each setting removes.
- **Tests**: a dependency-free Node suite plus end-to-end runs against a real
  Chrome, including a full export and a scheduled backup fired by a real alarm.

### Changed

- The DOM scraper is now the fallback, not the primary path. An export records
  which route produced it, and the badge and popup say so.
- Attachments are folded into the message they were sent with by default. AI
  Studio files each one as its own message, so a question sent with three
  screenshots was previously four messages.
- Anything excluded by a setting is counted rather than dropped: a message says
  `2 attachments not included in export` instead of rendering as a bare
  heading.
- Exported files no longer use emoji. Role headings are plain text and
  attachments carry an `Attachment:` prefix; the HTML export uses inline SVG.
- **Fewer permissions.** `activeTab`, `scripting` and `downloads` are gone:
  nothing called `chrome.scripting`, the host permission already covers the AI
  Studio tab, and exports save through the page rather than `chrome.downloads`.
  What remains is `storage`, `alarms` and the two hosts, and installing no
  longer asks to "Manage your downloads".
- The store name is "AI Studio Exporter: Fully Open Source". The toolbar
  tooltip and the popup still say "AI Studio Exporter".

### Fixed

- Inverted reasoning detection, which mislabelled thinking as the answer.
- Markdown link targets now percent-encode `(`, `)`, `#` and `?`. A parenthesis
  in a filename ended the link early, which silently broke every link in any
  conversation containing two files of the same name.
- `[Content_Types].xml` is written first in the `.docx` archive, without which
  Word refuses to open it.
- The CSV header is emitted once per library export rather than once per
  conversation.
- Windows Explorer could refuse a library archive as "invalid" while other
  tools opened it: one attachment with a 218-character name put a path at
  Windows' 260-character limit. Paths inside archives are now capped (folders
  at 60 characters, attachments at 80, extensions kept), well clear of it
  even after the extract folder is added.

## [1.0.1] - 2026-02-19

### Fixed
- Fixed issues with raw mode toggling functionality
- Improved image scraping reliability

### Added
- Added GitHub repository link button to popup interface

## [1.0.0] - 2025-11-20

### Added
- Initial release of AI Studio Exporter
- Full conversation export from Google AI Studio
- Support for user text messages
- Support for user image messages
- Support for user file attachemnts (partial: only previews, file names & token sizes)
- Support for AI model responses
- Support for AI model reasoning blocks
- Image attachment extraction and download
- Blob URL to base64 conversion for images
- ZIP file generation with JSZip
- Markdown formatting for conversations
- Automatic file naming with timestamps
- Browser extension popup interface
- Status detection for AI Studio website

### Technical Features
- Manifest V3 compliance
- Content script for DOM manipulation
- Background service worker
- Message passing between components
- Asynchronous processing
- Blob URL handling
- Raw output mode automation
- Dynamic element detection
- Graceful error handling


## [Unreleased]

### Future Features
- Export to PDF
- Export to HTML with styling

---
