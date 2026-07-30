# Contributing to AI Studio Exporter

First off, thank you for considering contributing to AI Studio Exporter! It's people like you that make open source such a great community.

We welcome any type of contribution, not just code. You can help with:
- **Reporting a bug**
- **Discussing the current state of the code**
- **Submitting a fix**
- **Proposing new features**
- **Becoming a maintainer**

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue on our GitHub repository. When you are creating a bug report, please include as many details as possible. Fill out the required template, the information it asks for helps us resolve issues faster.

### Suggesting Enhancements

If you have an idea for a new feature or an enhancement to an existing one, please open an issue to discuss it. This allows us to coordinate our efforts and prevent duplication of work.

### Pull Requests

Pull requests are the best way to propose changes to the codebase. We actively welcome your pull requests:

1.  **Fork the repo** and create your branch from `main`.
2.  If you've added code that should be tested, add tests.
3.  If you've changed APIs, update the documentation.
4.  Ensure the test suite passes.
5.  Make sure your code lints.
6.  Issue that pull request!

## Development

### Running the extension

No install step is needed to run or hack on the extension:

1. Clone the repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**
   and select the repository folder.
3. After changing a file, hit reload on the extension card, then reload the
   AI Studio tab so content scripts re-inject.

To confirm the content script is live on a page, check for the
`data-ai-studio-exporter` attribute on `<html>` — it holds the extension version.

### Tests

```bash
npm test          # everything
npm run test:core # skips the tests that need a build
```

Everything except `test/documents.js` runs on plain Node with no dependencies,
so the suite works on a fresh clone. `test/documents.js` needs the bundle described
below and skips itself when it is absent.

`test/run.js` holds the unit tests and a handful of static checks on the repo
itself — no literal control characters in source, every id the extension pages
reach for exists in their markup, every fetched origin has a host permission.
`test/batch.js` drives whole-library export end to end with only the API and
the download faked. `test/license.js` fakes storage and the network to cover
the cases that decide whether a paying user keeps access — Polar unreachable, a
revoked key, an activation slot being released. `test/attachments.js` fakes
Drive and counts requests, because most of what matters there is about requests
that should *not* happen.

### Building

Only DOCX and PDF need a build; everything else is plain source the browser
loads directly.

```bash
npm install
npm run build        # or: npm run build:watch
```

This bundles `pro/formats/documents.src.js` into
`vendor/pro-documents.bundle.js` with esbuild. **That output is committed**, so
you only need to run it if you change that one file — and you should commit the
rebuilt bundle alongside your change.

The build fails if the bundle contains `eval`, `new Function` or
`importScripts`, since Manifest V3's CSP blocks them at runtime. Dependencies
sometimes ship unreachable instances of these; if you hit one, confirm it really
cannot execute and add it to `KNOWN_UNREACHABLE` in `build.js` with a note
explaining why.

See [THIRD-PARTY.md](THIRD-PARTY.md) for the dependency list and licensing.

### A note on non-ASCII characters in source

Write control characters and unusual codepoints as escapes (`\u0000`, `\u00A0`),
never as literals. A raw NUL byte inside a regex character class once silently changed
which characters a sanitiser matched, and was invisible in review. `npm test`
fails the build if a literal control character appears in any source file.

## Styleguides

### Git Commit Messages

- Use the present tense ("Add feature" not "Added feature").
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...").
- Limit the first line to 72 characters or less.
- Reference issues and pull requests liberally after the first line.

### JavaScript Styleguide

All JavaScript must adhere to standard coding styles. We use linters to enforce this, so please ensure your code passes the linting checks.

## Any questions?

If you have any questions, feel free to open an issue and we will be happy to help you.
