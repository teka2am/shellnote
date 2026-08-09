# Help

The same manual as the **?** button in the header, as a note you can read, search and edit like any other. Delete it whenever you like — the **?** button always has the current copy.

## What shellnote is

A local notebook for runnable Markdown notes. Notes are plain `.md` files; every fenced code block tagged `powershell`, `cmd`, `bash` or `gitbash` becomes a cell you can run with one click. The server binds to `127.0.0.1` only — nothing is reachable from the network.

A wiki page *describes* a command. Here you click it.

## Editing notes

Text renders as regular Markdown.

| To do this | Do that |
|:-----------|:--------|
| Edit a paragraph | Click the pencil in its hover gutter, or double-click the text |
| Insert text or a block | Hover between sections for the `+` line, then pick **Text** or **Code Block** |
| Turn a paragraph into a block | The `<>` button in its gutter — Markdown formatting is dropped |
| Reorder | Drag the `⠿` handle; the highlighted line shows where it lands |
| Edit the whole note as text | The `<>` toggle in the header |

Files edited outside the app are picked up when you reload the note.

### Markdown supported

Headings, **bold** / *italic* / ~~strikethrough~~ (`**` or `__`), `inline code`, links and images, bullet and numbered lists including nested ones, task lists, blockquotes, horizontal rules, tables with alignment, and code fences — shell tags become runnable blocks, other tags display as code.

- [x] Task lists render as checkboxes
- [ ] They're read-only: the file is the source of truth, so tick them by editing the text

Not supported: footnotes, reference links, bare-URL autolinking, and raw HTML, which is escaped rather than rendered.

## Organising the sidebar

Drag notes to arrange them; the sort button restores A–Z and is greyed out when the list already is. Hover a note and click its star to add it to **Quick access**, a collapsible section above the list that stays hidden until something is starred — it keeps its own arrangement, and is dragged the same way.

Both the arrangement and the Quick access set are remembered per notes folder.

## Where blocks run

Each block's header shows the folder it will run in. The starting point is the **Run folder** in Settings, which defaults to wherever the server was started.

A `cd` inside a block shifts the folder of the blocks below it, so a runbook written as *"cd into the project, then build"* runs the way it reads. Each shell keeps its own folder — a `cd` in a `cmd` block never moves a `bash` one — and only forms that shell understands are recognised:

| Shell | Understands |
|:------|:------------|
| `cmd` | `cd`, `cd /d`, `chdir`, bare drive switch (`D:`) — case-insensitive |
| `powershell` | `cd`, `Set-Location`, bare drive switch, `~` |
| `bash`, `gitbash` | case-sensitive `cd`, `~`, bare `cd` goes home |

Targets built from environment variables can't be predicted, so they leave the folder unchanged.

## Interactive input

While a block runs, an input row appears under its output — type a response and press Enter to send it to the process (`read`, `Read-Host`, `set /p`, y/n prompts). **End input** closes stdin for commands that read until end-of-input.

Input mode is **basic** by default: line prompts work as-is, but programs that refuse to prompt without a real terminal (`ssh`, `sudo`) won't. Optionally run `npm install node-pty` in the shellnote folder and restart — the app detects it and switches to full-terminal input.

> Full-screen terminal programs (vim, htop, arrow-key menus) are not supported either way: the output view is plain text, not a terminal emulator. Sent input is echoed into the output and stored in the run log, so avoid typing secrets.

## Processes

The **Processes** tab lists every run across all notes — running and recent — with live status, duration, output size, a pop-out window (which also accepts input), Kill and Remove. History survives a server restart.

## Shells and platforms

| Tag | Windows | macOS / Linux |
|:----|:--------|:--------------|
| `powershell` | `powershell.exe` | `pwsh` (install separately) |
| `cmd` | `cmd.exe` | not available |
| `bash` | git-bash (install Git for Windows) | `/bin/bash` |
| `gitbash` | git-bash | use `bash` instead |

Blocks are otherwise stateless — each **Run** is a fresh process, so environment variables don't carry between blocks. Only the working directory is threaded through, as described above.

## Your data

Notes live in your notes folder, shown at the top of the sidebar. Settings and run logs live in the app data folder. Both are shown and changeable in **Settings**, and notes are never touched by anything there.
