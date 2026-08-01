# The toolbar badge

The small mark on the extension icon is the only thing that reports an export
you are not watching. It matters most for scheduled backups, which run in a
background tab with no overlay and no window of their own — without the badge,
a backup that failed three weeks ago looks exactly like one that worked.

- [The five badges](#the-five-badges)
- [Which one you get](#which-one-you-get)
- [What clears them](#what-clears-them)
- [Why a downgrade is red](#why-a-downgrade-is-red)

---

## The five badges

Hover the icon at any time — the tooltip says the same thing in words, and for
a finished export it repeats the result.

| Badge | Colour | State id | Meaning |
| --- | --- | --- | --- |
| `…` | grey `#5F6368` | `running` | **Export running.** Reading through the AI Studio API — the normal path. |
| `~` | amber `#B26A00` | `reading` | **Export running, reading the page.** The API was unavailable, so the conversation is being scraped from the rendered page instead. |
| `✓` | green `#2F9E44` | `done` | **Finished.** Everything asked for is in the file. |
| `!` | amber `#B26A00` | `partial` | **Finished, but not completely.** Open the popup — it says what was missing. |
| `X` | red `#C92A2A` | `failed` | **Did not finish, or did not do what you asked.** Open the popup for the reason. |

The state ids are what the code calls them — `src/badge.js` — and what
`chrome.storage.local.runStatus` records.

No badge at all means nothing has run since you last opened the popup.

## Which one you get

`…` and `~` are live states. The moment a single-conversation export gives up
on the API and falls back to reading the page, grey becomes amber — while the
slow part is still running, not after it.

When the export ends, one of the last three replaces it:

| Outcome | Badge |
| --- | --- |
| Everything exported | `✓` |
| Read from the page rather than the API (`source: "dom"`) | `!` |
| One or more attachments could not be downloaded | `!` |
| A library export where some conversations failed | `!` |
| The format could not represent something — non-Latin text in a PDF, say | `!` |
| The export failed, or you cancelled it | `X` |
| A Pro format was requested without a licence and exported as Markdown | `X` |
| Library export requested without a licence | `X` |
| A scheduled backup could not start — no tab, or the browser is signed out | `X` |

`!` always means a file was produced. `X` means either no file, or not the file
you asked for.

The amber pair — `~` while running and `!` when finished — are the same signal
at two moments: what you get from the page is thinner than what the API
returns. No token counts, no model settings, no system instruction, and only
the attachments the page had already rendered. See
[`source`](data-reference.md#source).

## What clears them

| Badge | Clears |
| --- | --- |
| `…` `~` | When the export ends. |
| `✓` | By itself, after five seconds. |
| `!` `X` | **When you open the popup.** Not before. |

That asymmetry is the point. A success you missed costs nothing; a failure you
missed costs the backup. So the two that need reading stay until they have been
read, and opening the popup is the acknowledgement.

The popup shows the message that goes with the badge — the same sentence the
tooltip carries — under the export buttons, styled to match: green, amber or
red. It survives a browser restart, so a backup that failed overnight is still
explained in the morning.

## Why a downgrade is red

Requesting PDF without a licence produces a Markdown file. Nothing failed, and
`!` would be the tidier choice — but you asked for one thing and got another,
and the place people normally discover that is their downloads folder, a week
later, when they go looking for the PDF. Red now is cheaper.

The export still runs and the file is still saved. The badge and the popup
message are the whole of the complaint.
