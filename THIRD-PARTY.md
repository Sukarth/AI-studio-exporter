# Third-party code

Everything bundled here is MIT-licensed, matching this project, apart from the
two typefaces, which are under the SIL Open Font License.

## Vendored at runtime

| Library | Version | License | Used for | Where |
|---|---|---|---|---|
| [JSZip](https://stuk.github.io/jszip/) | 3.x | MIT | Building the export archive | `libs/jszip.min.js` |
| [docx](https://github.com/dolanmiu/docx) | ^9.7 | MIT | `.docx` generation | bundled into `vendor/pro-documents.bundle.js` |
| [pdf-lib](https://pdf-lib.js.org/) | ^1.17 | MIT | `.pdf` generation | bundled into `vendor/pro-documents.bundle.js` |

## Fonts

| Font | License | Used for | Where |
|---|---|---|---|
| [Manrope](https://github.com/sharanda/manrope) | OFL-1.1 | Interface text | `fonts/manrope-latin.woff2` |
| [IBM Plex Mono](https://github.com/IBM/plex) | OFL-1.1 | Counts, keys, version numbers | `fonts/plex-mono-*-latin.woff2` |

Latin subsets, taken from the Google Fonts CDN and committed here rather than
linked. An extension that fetches a typeface at runtime tells a third party
every time its popup is opened, and would fall back to a system font offline.
Three files, 55 kB in total.

## Icons

The interface icons are inline SVG in the shape of
[Lucide](https://lucide.dev/) (ISC). Nothing is imported: each path is written
into the page that uses it, so there is no icon font, no sprite fetch and no
dependency to keep current.

## Build-time only

| Tool | Version | License | Used for |
|---|---|---|---|
| [esbuild](https://esbuild.github.io/) | ^0.28 | MIT | Bundling `pro/formats/documents.src.js` |

Build-time tooling is not shipped in the extension package.

## Why only two formats are bundled

Every script in this extension is plain source the browser loads directly,
which keeps the code auditable and lets anyone clone the repository and load it
unpacked without installing anything. DOCX and PDF are the sole exceptions:
producing those formats by hand would mean reimplementing OOXML packaging and
PDF text layout, so they depend on libraries and therefore need a bundler.

The build output is **committed** to `vendor/`, so the no-install path still
works. You only need Node if you intend to change `pro/formats/documents.src.js`.

## Notes on the PDF implementation

`pdf-lib` was chosen over higher-level renderers such as pdfmake for two
reasons. It produces a bundle roughly a third of the size, and it runs under
Node, so PDF output is covered by `test/documents.js` rather than being checked
by eye. The tradeoff is that text layout (wrapping, pagination, page numbering)
is implemented in `documents.src.js` rather than provided.

`pdf-lib`'s standard fonts encode WinAnsi only. Common typographic characters
(smart quotes, dashes, ellipses) are substituted; anything outside the encoding
becomes `?`. The PDF format reports a warning when a conversation contains such
text, pointing the user at the HTML export, which has no such limitation and
prints to PDF from the browser with full Unicode.
