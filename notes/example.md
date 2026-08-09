# Example Note

A short tour of what shellnote does. Every code block below is runnable — press **Run** and the output appears underneath.

## 1. Running a block

Each block runs on its own. The folder it will run in is shown in its header.

```bash
echo "Hello from bash"
date
```

```powershell
Get-Date
Write-Host "Hello from PowerShell"
```

```cmd
echo Hello from cmd
dir
```

> `cmd` and `gitbash` blocks only run on Windows. On macOS and Linux, `bash` uses `/bin/bash` and `powershell` needs `pwsh` installed.

## 2. The folder a block runs in

Blocks start in the **Run folder** (Settings), but a `cd` carries down the note — watch the folder label on the block below change when you edit the `cd` above it.

```bash
cd ..
pwd
```

```bash
echo "This block starts one folder up, because of the cd above."
pwd
```

Each shell keeps its own folder, so a `cd` in a `bash` block never moves a `powershell` one.

## 3. Blocks that ask for input

Run this, then type an answer into the input row that appears under the output and press Enter.

```bash
echo "What is your name?"
read name
echo "Nice to meet you, $name!"
```

```powershell
$name = Read-Host "What is your name?"
Write-Host "Nice to meet you, $name!"
```

```cmd
set /p name=What is your name?
echo Nice to meet you, %name%!
```

## 4. Long-running jobs

Start this and switch to the **Processes** tab — it's listed there with a live duration and a Kill button, alongside anything running in your other notes.

```bash
echo "starting a long-running task..."
for i in $(seq 1 30); do
  echo "tick $i"
  sleep 1
done
echo "done"
```

## 5. It's still just Markdown

Everything outside the code blocks is ordinary Markdown, so a runbook stays readable on GitHub:

| Command | What it does | Risk |
|:--------|:-------------|:----:|
| `git status` | show the working tree | low |
| `git reset --hard` | **discard** local changes | high |

Pre-flight checklist:

- [x] backup taken
- [ ] maintenance window open
- [ ] team notified

Deploy steps:

1. Stop the service
   - drain connections
   - wait for in-flight jobs
2. Deploy
   - run migrations
3. Verify

Hover any paragraph for its edit gutter, hover between blocks for the `+` line, or use the `<>` button in the header to edit the whole note as raw Markdown.
