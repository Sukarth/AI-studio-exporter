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
`data-ai-studio-exporter` attribute on `<html>`; it holds the extension version.

### Tests

```bash
npm test              # the dependency-free suite
npm run test:core     # just the unit tests
npm run test:ui       # popup, options and service worker in a real Chrome
npm run test:ui:export # a full export, end to end, in a real Chrome
npm run test:ui:alarm  # a scheduled backup, fired by Chrome's own alarm
npm run test:all      # all of the above
```

Everything except `test/documents.js` runs on plain Node with no dependencies,
so the suite works on a fresh clone. `test/documents.js` needs the bundle described
below and skips itself when it is absent.

`test/run.js` holds the unit tests and a handful of static checks on the repo
itself. These check for literal control characters in source, every id the extension pages
reach for exists in their markup, every fetched origin has a host permission.
`test/batch.js` drives whole-library export end to end with only the API and
the download faked, including volume splitting: production starts a new archive
at 256 MB, and the threshold is read through `AISE.batch.VOLUME_BYTES` so the
splitting logic can be exercised at a few kilobytes rather than by generating a
quarter of a gigabyte of conversations. `test/license.js` fakes storage and the network to cover
the cases that decide whether a paying user keeps access: Polar unreachable, a
revoked key, an activation slot being released. `test/attachments.js` fakes
Drive and counts requests, because most of what matters there is about requests
that should *not* happen. `test/badge.js` freezes `Date.now` so the toolbar
badge's expiry window is something to step over rather than sleep through, and
concentrates on what must *not* vanish: a failure survives a service worker
restart, and stays gone once the popup has acknowledged it.

### Browser tests

The three browser suites need Playwright, which is a devDependency:

```bash
npm install
npx playwright install chromium
```

They launch a real Chrome with the extension really loaded, so they cover what
a faked `chrome.*` never can: a broken manifest, an unregistered listener, a
page that throws on load, an alarm that is not actually created.

`test/ui-export.js` runs a whole export without a Google account. Playwright
fulfils requests to `https://aistudio.google.com/**` itself, so the page carries
that real origin (which is what decides whether Chrome injects the content
scripts), while the body is ours. The MakerSuite RPC and Drive are answered with
canned wire-format fixtures, and the downloaded archive is read back off disk
and checked byte for byte. It also reads the toolbar badge back out of
`chrome.action`, which is the only way to know Chrome painted what the code
asked for. Catching the progress overlay mid-export needs the network to be
slow, so the RPC mock honours a one-shot `seen.stallMs` delay. Without it the
overlay exists for a couple of frames.

`test/ui-alarm.js` covers scheduled backups the only way that proves anything:
it registers a real `chrome.alarms` alarm and waits for Chrome to fire it,
rather than calling `runBackup()`. If the alarm never fires, or the service
worker is not around to hear it, no download appears and the test fails. Chrome
honours a sub-minute delay for an unpacked extension; the archive lands about
a second after the alarm is armed and clamps to a minute otherwise, which the
timeout accommodates. The scheduling contract, that a daily backup arms a
1440-minute alarm, is asserted against the alarm `configure()` really creates.

Two constraints worth knowing before you edit them:

- **Headed only.** Loading an unpacked MV3 extension headlessly does not
  reliably start the service worker on current Chrome. CI needs a display.
- **One browser launch per process.** Repeated `launchPersistentContext` calls
  in a single process intermittently fail to load the extension at all, which
  is why the two browser suites are separate files rather than one.

Polar is intercepted, never called; activations are seat-limited and a test run
must not spend one.

### Building

Only DOCX and PDF need a build; everything else is plain source the browser
loads directly.

```bash
npm install
npm run build        # or: npm run build:watch
```

This bundles `pro/formats/documents.src.js` into
`vendor/pro-documents.bundle.js` with esbuild. **That output is committed**, so
you only need to run it if you change that one file; you should commit the
rebuilt bundle alongside your change.

The build fails if the bundle contains `eval`, `new Function` or
`importScripts`, since Manifest V3's CSP blocks them at runtime. Dependencies
sometimes ship unreachable instances of these; if you hit one, confirm it really
cannot execute and add it to `KNOWN_UNREACHABLE` in `build.js` with a note
explaining why.

See [THIRD-PARTY.md](THIRD-PARTY.md) for the dependency list and licensing.

### The design system

Every colour, radius and typeface the extension uses is a custom property in
`theme.css`. Do not write a hex value into a page's `<style>` block; if you
need a colour that is not there, add a token.

The palette is built around one rule: **azure only ever means "this is the
action"**. It is never decorative. Green, amber and red only ever mean state.
Anything else is graphite.

Two palettes exist, `:root` (dark, also the default) and
`:root[data-theme='light']`. Each is declared exactly once. `theme-init.js`
runs synchronously in `<head>` on both extension pages, resolves the stored
`theme` setting (`system`, `dark` or `light`) to a concrete value and writes
the attribute before first paint. The resolved value is mirrored into
`localStorage` because `chrome.storage` is callback-based and would paint a
frame late; both pages then correct it from `storage.sync` on load, which
matters on a browser the profile has only just synced to.

The injected overlay is the one exception, by necessity: it lives in a
document we do not control and cannot link a stylesheet of ours, so
`OVERLAY_CSS` in `content.js` carries its own copy of the tokens it needs.
**Change a colour in `theme.css` and change it there too.** `npm test`
compares the two files token by token, in both palettes, and fails on any
value that has drifted; it also fails if the overlay stops sharing enough of
the palette for that comparison to mean anything.

Adding a setting means adding it to `AI_STUDIO_DEFAULT_SETTINGS` in
`settings.js`, sanitising it in `sanitizeSettings`, and documenting it in
`docs/settings.md`. The test suite fails on an undocumented setting.

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
