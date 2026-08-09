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

Blocks run independently — no shared working directory or variables between them in v1.
