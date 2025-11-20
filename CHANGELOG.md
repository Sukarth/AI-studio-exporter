# Changelog

All notable changes to the AI Studio Exporter extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/sukarth/ai-studio-exporter/releases/tag/v1.0.0
