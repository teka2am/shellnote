# shellnote

A local notebook for running PowerShell / cmd / bash / git-bash commands. Notes are plain `.md` files with fenced code blocks that render as runnable, independently-executed cells, plus a live view of every running process across all notes.

## Why

A wiki page only *describes* a command — shellnote *runs* it. Turn a runbook from "read it, alt-tab to a terminal, retype it, hope you got it right" into "click it."

**Who it's for:**

- **QA/test automation engineers** with a recurring sequence of setup commands — launch a browser in debug mode, spin up a replay server, run a test script, tail a log. Each step becomes a button instead of a copy-paste round trip.
- **DevOps/SRE folks maintaining runbooks** — incident response steps, deploy checklists, "how to restart the stack" — where you don't want someone fat-fingering a command from a wiki page under pressure.
- **Anyone juggling PowerShell/cmd/bash/git-bash on Windows** — each block is tagged with its shell, so there's no "wait, was this one PowerShell or cmd?".
- **Teams onboarding new hires** — an environment-setup doc a new person can click through and run, instead of retyping commands into their own terminal.

**What's genuinely useful about it:**

- **One dashboard for everything running, everywhere.** Kick off a build in one note, a test server in another, a long diagnostic script in a third — the Processes tab shows all of them live, with kill buttons, regardless of which note started them.
- **Fire-and-forget long jobs.** Start a long-running command, pop its output into a separate window, go do something else — output keeps streaming and you can check back without babysitting a terminal.
- **It's still just Markdown.** The "runbook" is a plain `.md` file — git-diffable, greppable, readable on GitHub with zero tooling — but also executable when opened in shellnote. Documentation and tooling stay in the same artifact instead of drifting apart.

## Requirements

- [Node.js](https://nodejs.org) 18+ (no other dependencies — nothing to `npm install`)
- Windows: PowerShell and/or cmd are built in; for `bash`/`gitbash` blocks, [Git for Windows](https://git-scm.com/downloads) must be installed (the app looks for `bash.exe` under `Program Files\Git`)
- macOS/Linux: `bash` blocks use `/bin/bash`; `powershell` blocks need `pwsh` installed if you want to use them

## Install

Clone or copy this folder anywhere — it's fully self-contained:

```
git clone <your-repo-url> shellnote
cd shellnote
```

No build step, no `npm install`.

## Start

```
node server.js
```

Then open **http://127.0.0.1:4488** in your browser. The server only binds to `127.0.0.1` (localhost) — it executes arbitrary shell code, so it's intentionally not reachable from the network.

To use a different port:

```
PORT=5000 node server.js          # macOS/Linux
$env:PORT=5000; node server.js    # PowerShell
```

## Setup / folder layout

```
shellnote/
  notes/        <- your .md notebooks live here
  server.js
  src/          <- backend (parsing, shell spawning, execution tracking)
  public/       <- frontend (served as-is, no build)
```

`notes/` is just a plain folder of Markdown files — you can put it under its own git repo, sync it with Dropbox, etc.

## Usage

### Notes tab

- Pick a note from the left sidebar, or click **+ New** to create one (prompts for a filename).
- Each note is prose plus runnable blocks. Supported block languages: `powershell`, `cmd`, `bash`, `gitbash`.
- **Editing directly in the browser**: every block of text or code is an editable textarea.
  - **+ Text** adds a new prose block; **+ Code Block** adds a new runnable block (pick its shell from the dropdown).
  - **Remove** on any block deletes it from the note.
  - **Save** writes your current edits back to the note's `.md` file.
  - **Save As** writes the current content to a new file (prompts for a filename) and switches to it.
  - **Delete** removes the note file entirely (asks for confirmation).
- **Run** executes a block as its own process (no shared working directory or variables between blocks in this version). Output streams live; after it finishes, only the last ~10 lines show by default — click **Show more** / **Show less** to expand or collapse.
- **Kill** stops a running block's process (and any child processes it spawned).

You can also edit `.md` files directly on disk with any editor — the format is plain Markdown with fenced code blocks:

````markdown
```powershell
Get-Date
```
````

Reload the note in the browser to pick up external edits.

**Markdown supported:** headings, bold/italic/strikethrough (`**` or `__`), inline code, links and images, bullet and numbered lists including nested ones, task lists (`- [ ]` / `- [x]`, rendered as read-only checkboxes — tick them by editing the text), blockquotes, horizontal rules, tables with `:---:` alignment, and code fences (shell tags become runnable blocks, other tags display as code). Not supported: footnotes, reference links, bare-URL autolinking, and raw HTML, which is escaped rather than rendered.

### Organising the sidebar

Drag notes to arrange them; the sort button restores A–Z (greyed out when the list already is). Hover a note and click its star to add it to **Quick access**, a collapsible section above the list that stays hidden until something is starred. Both the arrangement and the Quick access set are remembered per notes folder.

### Reading a log (pop-out)

A block's own output stays a plain scrolling transcript. **Pop out** — from a block header, or **View** in the Processes tab — opens that same run in a log viewer meant for output too long to skim, and works on a live run or a finished one.

Highlights and bookmarks only ever add a background or a margin marker. **The log's own text is never recoloured or rewritten**, so nothing a command actually printed is misrepresented.

- **Search** as plain text or a regular expression (`.*`), with `Aa` for case sensitivity, `‹` `›` to step through hits (Enter / Shift+Enter), and **Only matches** to hide every non-matching line. Ctrl+F focuses the box, Esc clears it.
- **Highlights** colour the background of any line containing one of their keywords, configured in Settings (see below) or per-run from the pop-out's own **Settings** button.
- **Bookmarks** — hover any line and a hollow bookmark icon appears at its left edge. Click it to bookmark the line in the default colour, or hover it to expand five colours plus a comment box; clicking a filled icon removes the bookmark. A bookmarked line keeps that icon, in its colour, in the left gutter. A commented line shows its note on hover, and on the ruler mark's tooltip. Bookmarks and comments save themselves and come back when you next open that run.
- **Structured data** — JSON, XML and HTML get found wherever they were printed: inline behind a timestamp, spread over fifty lines, or wrapped. Hover one and the data itself is shaded, from its first character to its last and no further, with a copy chip at the end that puts the whole block on the clipboard — the log's own text around it is left alone. Detection is deliberately forgiving rather than strict, because the job is helping you copy the thing, not validating it.
  - **When it gets it wrong**, select any part of the data yourself. The viewer looks outwards from your selection for a structure that contains it — broken quotes and all — and shades the whole thing. **Ctrl+C** still copies exactly the characters you selected; the chip copies the block worked out from them. Esc drops it, and so does clicking anywhere in the log.
  - The **Data** button turns the whole thing off for logs it reads badly, and the status bar counts what was found.
- **The right-hand ruler** replaces the scrollbar. It shows every highlighted line as a coloured bar, every bookmark as a fixed-size mark, and every data block as a rail down its left edge, so a 20,000-line run is one glance. Click to jump, drag to scrub, and hover to widen it — the bookmark marks deliberately keep their size so they don't move under the pointer.
- **The panel** appears when you hover the top-right corner: every highlight with its count, each one a toggle that hides those lines, plus **Other lines** for everything neither highlighted nor bookmarked. **All** / **None** flip the whole set at once. Bookmark colours are listed below with their own counts and toggles, so you can strip a run down to just what you marked.
- **Following** releases the moment you scroll up or step through matches, so incoming output can't drag the view away while you read; **Jump to latest** resumes it.
- **Markup** controls the highlight backgrounds and nothing else — with it off the text reads exactly as the process emitted it, while the bookmark icons on the left and the ruler on the right carry on working. It starts **off** until this log's highlights have been configured, since the seeded keywords otherwise paint nearly every line. The search controls end with an **Only matches** checkbox and are divided from the rest of the toolbar.
- `#` shows line numbers (they aren't included when you copy), **Data** toggles structured-data detection, **Wrap** switches between wrapped lines and a horizontal scroll, **Copy** / **Save** take exactly what the current filters leave visible, and the button at the far left of the header hides the toolbar for more log.

### Log highlights

**Settings → Log highlights** defines the keyword highlights the pop-out log viewer uses. A line containing one of a highlight's keywords gets that highlight's background colour; the log's own text is never recoloured, so nothing a command actually printed is misrepresented.

Pick a highlight from the list to edit it on the right: name, colour, its keywords (added and removed one chip at a time), and whether it must match whole words (so `pass` doesn't match `password`) or an exact case. A preview shows a matching line as it will actually appear. A dot next to a highlight means it differs from the built-in default — everything else keeps following the defaults rather than being frozen as a copy, and **Reset to defaults** clears the lot.

The **Colour theme** sets how strong the colours are: **Subtle** is muted, **High contrast** is stronger and more saturated.

Everything in that dialog is **global**. **Settings** in the pop-out toolbar opens the same editor with an extra **Applies to** choice per highlight:

| Applies to | Affects | Beats |
|:-----------|:--------|:------|
| This log only | that one run | This note |
| This note | every run started from that note | Everywhere |
| Everywhere | all runs | the built-in defaults |

A line only ever gets one highlight, and the narrower scope wins — so a rule you add for a single log beats a broad global one like `error`. Without that, the seeded keywords would swallow every line and a rule written for one run could never show up.

### Interactive input

While a block is running, an input row appears under its output — type a response and press Enter to send it to the process (`read`, `Read-Host`, `set /p`, y/n prompts). **End input** closes stdin for commands that read until end-of-input. The pop-out output window has the same row.

Input mode is **basic** (pipe) by default: line prompts work as-is, but programs that refuse to prompt without a real TTY (ssh, sudo) won't. Optionally run `npm install node-pty` in the shellnote folder and restart to get full-terminal input — the app auto-detects it; nothing else changes. Full-screen terminal apps (vim, htop) are not supported either way. Sent input is echoed into the output and stored in the run log, so avoid typing secrets. See the in-app **Help** (?) for details.

### Processes tab

Shows every execution across **all** notes — running and recently finished (last 50) — with note, block number, shell, status, start time, and duration. Running processes show a **Kill** button here too, so you can monitor and stop anything without switching back to its note. The tab label shows a badge with the current running count.

Every row carries a **Comment** — your own note on that run ("prod deploy", "flaky, retried"). Double-click the cell or the pencil that appears on hover to edit it, Enter to save, Esc to cancel; long text truncates in the table and shows in full on hover. Comments are stored with the run and survive a restart.

### Where blocks run

- By default, blocks run in the folder the server was started from. Change it in **Settings → Run folder** (persisted).
- Each block's header shows the folder it will run in.
- A `cd` command inside a block also shifts the folder shown on (and used by) the blocks **below** it — the note is simulated top to bottom, so a runbook that says "cd into the project, then run the build" works the way it reads. Handled forms include `cd ..`, absolute paths, `cd \`, `cd D:\path`, bare drive switches (`D:`), and `~`. Targets using environment variables can't be predicted and leave the folder unchanged.
- Each shell keeps its **own** folder lineage: a `cd` in a `cmd` block only shifts the `cmd` blocks below it — interleaved `bash` or `powershell` blocks are unaffected, since a real cmd `cd` could never have influenced them. Only forms the block's shell actually understands are recognized (`cd /d`, `chdir`, bare `D:` for cmd; `Set-Location` and `D:` for powershell; case-sensitive `cd` with bare-`cd`-goes-home for bash).

## Notes on this version

- Blocks are otherwise stateless: each **Run** spawns a fresh shell process — environment variables do not carry over between blocks; only the working directory is threaded through as described above.
- Saving serializes the note's blocks back to Markdown; exact original spacing/formatting outside of block content isn't preserved byte-for-byte.
- No auth — this is a single-user local tool.

## License

Copyright © 2026 teka2am. Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).

In plain terms:

- **Use it freely**, including at work and inside a company, at no cost.
- **Modify it freely.** If you keep your changes to yourself, you owe nothing.
- **If you distribute it, or a product built on it, the source must be AGPL too** — you can't take this code closed.
- **If you run a modified version as a network service**, you must offer its source to that service's users (AGPL §13).

Versions up to and including v1.8.0 were released under the MIT License and remain available under those terms; the AGPL applies from v1.9.0 onward.

### Commercial licensing

If the AGPL's terms don't work for you — for example you want to build a closed-source product on this code — a separate commercial license can be arranged. Open an issue on the repository to get in touch.
