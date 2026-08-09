# Example Note

This is a demo note. Each fenced code block below is a runnable cell.

```powershell
Get-Date
Write-Host "Hello from PowerShell"
```

```bash
echo "Hello from bash/git-bash"
date
```

```cmd
echo Hello from cmd
dir
```

```bash
echo "starting a long-running task..."
for i in $(seq 1 30); do
  echo "tick $i"
  sleep 1
done
echo "done"
```

A block that prompts for input works too — Run it, then type an answer into the input row that appears under its output and press Enter.

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

Blocks run independently — no shared working directory or variables between them in v1.
