<p align="center">
  <img src="images/icon.png" alt="" width="96" height="96">
</p>

<h1 align="center">AI Studio Exporter</h1>

<p align="center">
  <b>Get your Google AI Studio conversations out.</b>
  <br>
  Every conversation or your whole library, with the real attachments, reasoning, model settings and timestamps.
  <br>
  9 formats. Exports under a second. 100% open source, including the paid features.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/ai-studio-exporter-fully/jggdlefieblocdjkhihbfihdknbdhhce"><img src="images/chrome-web-store.png" alt="Available in the Chrome Web Store" height="58"></a>
  &nbsp;
  <a href="https://www.producthunt.com/products/ai-studio-exporter-2?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-ai-studio-exporter-2"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1279230&theme=light" alt="AI Studio Exporter on Product Hunt" width="214" height="58"></a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/ai-studio-exporter-fully/jggdlefieblocdjkhihbfihdknbdhhce"><img alt="Version" src="https://img.shields.io/chrome-web-store/v/jggdlefieblocdjkhihbfihdknbdhhce?style=flat-square&label=version&color=4f9dfa"></a>
  <a href="https://github.com/Sukarth/AI-studio-exporter/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Sukarth/AI-studio-exporter?style=flat-square&logo=github&color=4f9dfa"></a>
  <img alt="Formats" src="https://img.shields.io/badge/formats-9-4f9dfa?style=flat-square">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-4f9dfa?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://exportaistudio.vercel.app">Website</a>
  &nbsp;·&nbsp;
  <a href="https://exportaistudio.vercel.app/docs">Docs</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Sukarth/AI-studio-exporter/releases/tag/v2.0.0">What's new in v2</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Sukarth/AI-studio-exporter/issues">Report a bug</a>
</p>

![Demo of AI Studio Exporter](https://raw.githubusercontent.com/Sukarth/AI-studio-exporter/main/images/Demo.gif)

## What it does

- **Exports the whole conversation**, not just what is on screen; there is no scrolling, no lazy-loading gaps.
- **Real attachments.** Files are fetched from Drive at full fidelity rather than saved as page thumbnails. Google Docs, Sheets and Slides are converted on the way out, and only the types you asked for are downloaded at all.
- **Reasoning kept separate** from the answer, so you can read either without the other.
- **Everything the API knows**: model, temperature, top-P, top-K, output limit, system instruction, per-message timestamps and token counts. Each one has its own on/off switch.
- **Nothing leaves your machine.** No analytics, no servers, no accounts. The only network request the extension ever makes on its own behalf is a one-time licence check, if you buy Pro.
- **Talks to AI Studio's own API** instead of scraping the page: a 200-message conversation used to take about two and a half minutes of automated scrolling; it now takes under a second. If the API is ever unavailable, the old page-scraping path is still there as a fallback.

## Formats

| Format | | |
|---|---|---|
| Markdown | `.md` | Free |
| JSON | `.json` | Free |
| Plain text | `.txt` | Free |
| HTML | `.html` | Pro: one self-contained page, images inlined |
| PDF | `.pdf` | Pro |
| Word | `.docx` | Pro |
| Obsidian | `.md` | Pro: frontmatter, wikilinked attachments, collapsed reasoning callouts |
| CSV | `.csv` | Pro: one row per message |
| JSONL | `.jsonl` | Pro: ready for fine-tuning |

**The [format documentation](docs/README.md)** covers what each format contains, every field in the JSON, JSONL and CSV exports, what lands in a `.zip`, and which setting removes what.

## Pro

A one-time payment. No subscription, no account, and the code stays open.

- **Whole-library export**: every conversation in one archive, with an index, filters and automatic splitting for large libraries.
- **Six extra formats** (above).
- **Scheduled backups**: daily, weekly or monthly, and incremental, so a routine run only fetches what changed.

Buy a key at [the purchase page](https://exportaistudio.vercel.app/#pricing), paste it into the extension's settings, and it works offline from then on.

### Why is a paid tier in an open source project?

Because the alternative is that this gets abandoned. Pro pays for the time to keep the extension working when Google changes their API, which they do.

To be completely straightforward about how the licence check works, since you can read the code anyway:

- **Keys cannot be forged.** Activation is validated against Polar, which is the source of truth. Nobody can mint a working key offline.
- **The check can be bypassed.** This is client-side JavaScript in an open source extension. Anyone can edit it out. No obfuscation is attempted, because none would survive contact with a determined person and it would only make the code harder to audit.

If you are going to remove the check, you may as well [open an issue](https://github.com/Sukarth/AI-studio-exporter/issues) about what you actually needed instead.

## Installation

**Install it** from the [Chrome Web Store](https://chromewebstore.google.com/detail/ai-studio-exporter-fully/jggdlefieblocdjkhihbfihdknbdhhce).

Works in Chrome and in Chromium browsers that can use the Chrome Web Store, such as Edge, Brave and Arc, and it updates itself. No cloning, no developer mode, no manual reloading.

### From source

For development, or if you would rather run exactly what is in this repository:

```bash
git clone https://github.com/sukarth/ai-studio-exporter.git
cd ai-studio-exporter
```

Then:

1. Open `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `ai-studio-exporter` folder.
4. Pin it to your browser's toolbar.

The built PDF/DOCX bundle is committed, so a plain clone works as-is and everything else runs with no dependencies at all. Only rebuild it if you have changed `pro/formats/documents.src.js`:

```bash
npm install
npm run build
```

### Updating

```bash
# navigate into the extension's folder if you are not already there
git pull origin main
# then hit the reload icon on the extension's card in chrome://extensions/
```

## Usage

1. Open a conversation on [AI Studio](https://aistudio.google.com/).
2. Click the extension icon.
3. Pick a format and click **Export this conversation**.

For the whole library, click **Export entire library** instead. Settings (what to export, default format, backup schedule) live behind the gear icon.

## What you get

A single conversation with attachments:

```
Conversation Title - 2026-07-29T14-30-00.zip
├── conversation.md
└── attachments/
    ├── diagram.png
    └── notes.pdf
```

If there is nothing to bundle (e.g. no attachments), you get the bare file (for example, `Conversation Title - 2026-07-29T14-30-00.md`) rather than a ZIP wrapped around a single document.

The whole library:

```
ai-studio-library-2026-07-29T14-30-00.zip
├── index.md                  # every conversation, dated and linked
├── manifest.json             # machine-readable, including anything that failed
├── Conversation Title/
│   ├── conversation.md
│   └── attachments/
└── Another Conversation/
    └── conversation.md
```

CSV and JSONL exports skip the folder structure and produce one dataset file for the whole library.

## Privacy

- Conversations are read, formatted and downloaded entirely inside your browser.
- Attachments are fetched directly from Google with your existing session. They do not pass through anything of ours.
- Settings sync with your Chrome profile; they contain no conversation content.
- The one exception, stated plainly: activating a Pro licence sends the key to Polar once. Nothing else is sent, and it is never sent again.
- See more in the [privacy policy](https://exportaistudio.vercel.app/privacy).

## How it works

- **API first.** `src/api/` speaks AI Studio's own RPC interface. Because those endpoints are CORS-locked to the AI Studio origin, the transport (`src/api/rpc.js`) runs in the page's MAIN world and is reached over `postMessage`; everything else stays in the isolated world.
- **One model, many writers.** Both the API path and the DOM fallback produce the same normalised conversation object (`src/model.js`), so a formatter never needs to know where the data came from.
- **`src/api/decode.js` is the only file that knows the wire format.** AI Studio sends protobuf-JSON positional arrays; the index maps live in that one file, so a renumbered field is a one-file fix.
- **Manifest V3**, vanilla JS, no framework. JSZip for archives; `docx` and `pdf-lib`, bundled with esbuild, for the two document formats.

### Permissions

| Permission | Description |
|---|---|
| `storage` | Remember your settings and licence |
| `alarms` | Scheduled backups |
| `host_permissions` | `aistudio.google.com`, to read the conversation you are on; `api.polar.sh`, for the licence check |

## Troubleshooting

- **"Reload the AI Studio page, then try again"** means the content script has not been injected, usually right after installing or updating the extension. Refresh the tab.
- **Export is slow, or the reasoning looks wrong** indicates the extension fell back to page scraping. Check the browser console (F12) for the reason and please open an issue; the API path should be handling it.
- **Nothing happens when you click Export**: check that the page is a conversation (`aistudio.google.com/prompts/…`) rather than the library index or an empty/new chat.
- **A few conversations failed in a library export** means the run continues past failures on purpose. `manifest.json` in the archive names each one and why.

## Contributing

Contributions are welcome, from bug reports to pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md), which covers the layout, how to run the tests (`npm test`, no dependencies needed) and how to rebuild the document bundle.

## License

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY.md](THIRD-PARTY.md) for more details.

---

Made with ❤️ by [Sukarth Acharya](https://github.com/Sukarth).
