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

### Interactive input

While a block is running, an input row appears under its output — type a response and press Enter to send it to the process (`read`, `Read-Host`, `set /p`, y/n prompts). **End input** closes stdin for commands that read until end-of-input. The pop-out output window has the same row.

Input mode is **basic** (pipe) by default: line prompts work as-is, but programs that refuse to prompt without a real TTY (ssh, sudo) won't. Optionally run `npm install node-pty` in the shellnote folder and restart to get full-terminal input — the app auto-detects it; nothing else changes. Full-screen terminal apps (vim, htop) are not supported either way. Sent input is echoed into the output and stored in the run log, so avoid typing secrets. See the in-app **Help** (?) for details.

### Processes tab

Shows every execution across **all** notes — running and recently finished (last 50) — with note, block number, shell, status, start time, and duration. Running processes show a **Kill** button here too, so you can monitor and stop anything without switching back to its note. The tab label shows a badge with the current running count.

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
