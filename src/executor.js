const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configStore = require('./config');

// Optional enhancement: if node-pty is installed (npm install node-pty in the
// app folder, then restart), blocks run inside a real pseudo-terminal, so
// programs that insist on a TTY before prompting (ssh, sudo, some CLI wizards)
// actually show their prompts. Without it everything still works over plain
// pipes — line-based prompts (read, Read-Host, set /p, y/n questions) are fully
// usable; only TTY-demanding programs misbehave.
let pty = null;
try { pty = require('node-pty'); } catch { /* not installed — pipe mode */ }

// PTY output carries ANSI escape sequences (colors, cursor movement, window
// titles) that the plain-text output view can't render — strip them, keeping
// newlines and tabs.
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (window title etc.)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colors, cursor)
    .replace(/\x1b[()#][0-9A-Za-z]/g, '') // charset selection
    .replace(/\x1b[@-Z\\-_]/g, ''); // remaining two-byte escapes
}

// Cap retained output per execution by actual size, not chunk count — a single
// stdout chunk can be up to ~64KB, so capping by count alone could retain
// hundreds of MB for a chatty long-running process. That both bloats memory
// and makes every reconnect (record.output.join('')) a multi-MB synchronous
// operation that can stall the whole server's event loop.
const MAX_BUFFER_CHARS = 1_000_000; // ~1MB of retained output per execution
const TRIM_TARGET_CHARS = MAX_BUFFER_CHARS * 0.8; // trim back below this so we don't re-trim on every push at the boundary
const HISTORY_LIMIT = 50;

const executions = new Map(); // execId -> record
const finishedOrder = []; // execId order, for trimming history

// Finished/killed executions are persisted to disk (history index + one output
// file per execution) inside the app data folder, so they survive a server
// restart. Still-running processes are never persisted — if the server exits
// mid-run, that run simply isn't "history" yet.
function logsDir() {
  return path.join(configStore.getAppDataDir(), 'logs');
}

function historyIndexPath() {
  return path.join(logsDir(), 'history.json');
}

function outputFilePath(execId) {
  return path.join(logsDir(), `${execId}.log`);
}

function persistHistoryIndex() {
  const summaries = finishedOrder
    .map((id) => executions.get(id))
    .filter(Boolean)
    .map((r) => toSummary(r));
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(historyIndexPath(), JSON.stringify(summaries), 'utf8');
  } catch {
    // Best-effort persistence — a write failure here shouldn't break execution tracking.
  }
}

function persistOutput(record) {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(outputFilePath(record.execId), record.output.join(''), 'utf8');
  } catch {
    // Best-effort.
  }
}

function deleteOutputFile(execId) {
  try {
    fs.unlinkSync(outputFilePath(execId));
  } catch {
    // Already gone, or never written.
  }
}

function loadPersistedHistory() {
  let summaries;
  try {
    summaries = JSON.parse(fs.readFileSync(historyIndexPath(), 'utf8'));
  } catch {
    return; // no persisted history yet
  }
  for (const summary of summaries) {
    let text = '';
    try {
      text = fs.readFileSync(outputFilePath(summary.execId), 'utf8');
    } catch {
      // output file missing/unreadable — keep the summary, just without output text
    }
    const record = {
      ...summary,
      output: text ? [text] : [],
      outputChars: text.length,
      listeners: new Set(),
      child: null,
    };
    executions.set(summary.execId, record);
    finishedOrder.push(summary.execId);
  }
}

loadPersistedHistory();

function createExecution({ shellPath, args, cwd, noteFile, noteTitle, blockIndex, shellTag, verbatim, notesFolder }) {
  const execId = crypto.randomUUID();

  const record = {
    execId,
    noteFile,
    noteTitle,
    blockIndex,
    notesFolder, // absolute notes-folder path active when this ran, so history
                 // links stay correct even after switching notes folders and back
    shell: shellTag,
    status: 'running',
    pid: null,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    output: [],
    outputChars: 0,
    listeners: new Set(),
    child: null,
    usesPty: false,
  };
  executions.set(execId, record);

  const env = {
    ...process.env,
    // Python defaults stdout/stderr to the legacy Windows code page (e.g. cp1252)
    // when they aren't attached to a real console, which is always true here since
    // we capture output through a pipe — that breaks on any non-ASCII character.
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    // Python block-buffers stdout when it isn't a TTY (always true here), instead of
    // line-buffering. A script that prints a startup banner and then blocks forever
    // (e.g. a server loop) may never fill that buffer, so the banner sits unflushed
    // and never reaches us. Force unbuffered I/O so output streams live as it's printed.
    PYTHONUNBUFFERED: '1',
  };

  if (pty) {
    try {
      const term = pty.spawn(shellPath, args, { cwd, cols: 120, rows: 30, env });
      record.pid = term.pid;
      record.child = term;
      record.usesPty = true;
      term.onData((data) => appendOutput(record, stripAnsi(data)));
      term.onExit(({ exitCode }) => {
        if (record.status === 'killed') return;
        finish(record, exitCode === 0 ? 'success' : 'failed', exitCode);
      });
      return execId;
    } catch (err) {
      // Broken node-pty install (ABI mismatch etc.) — fall through to pipes.
      appendOutput(record, `[node-pty unavailable: ${err.message} — running without a terminal]\n`);
    }
  }

  const child = spawn(shellPath, args, {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: !!verbatim,
    env,
  });
  record.pid = child.pid;
  record.child = child;

  child.stdout.on('data', (chunk) => appendOutput(record, chunk.toString()));
  child.stderr.on('data', (chunk) => appendOutput(record, chunk.toString()));

  child.on('error', (err) => {
    appendOutput(record, `\n[spawn error] ${err.message}\n`);
    finish(record, 'failed', null);
  });

  child.on('close', (code) => {
    if (record.status === 'killed') return;
    finish(record, code === 0 ? 'success' : 'failed', code);
  });

  return execId;
}

// ---- interactive input ----
// Sends one line to a running block's stdin. In pipe mode the process never
// echoes what it reads, so we mirror the text into the output ourselves to keep
// the transcript readable; a PTY echoes on its own.
function sendInput(execId, text) {
  const record = executions.get(execId);
  if (!record || record.status !== 'running' || !record.child) return false;
  if (record.usesPty) {
    record.child.write(text + '\r'); // Enter in a terminal is CR
  } else {
    record.child.stdin.write(text + '\n');
    appendOutput(record, text + '\n');
  }
  return true;
}

// The Ctrl+D / Ctrl+Z equivalent — for programs that read until end-of-input.
function closeInput(execId) {
  const record = executions.get(execId);
  if (!record || record.status !== 'running' || !record.child) return false;
  if (record.usesPty) {
    record.child.write(process.platform === 'win32' ? '\x1a\r' : '\x04');
  } else {
    record.child.stdin.end();
    appendOutput(record, '[input closed]\n');
  }
  return true;
}

function appendOutput(record, text) {
  record.output.push(text);
  record.outputChars += text.length;
  // Trim in a batch back down to the target rather than shifting one chunk off on
  // every single push — the latter is O(n) per push and adds up fast under high output volume.
  if (record.outputChars > MAX_BUFFER_CHARS) {
    while (record.outputChars > TRIM_TARGET_CHARS && record.output.length > 1) {
      record.outputChars -= record.output.shift().length;
    }
  }
  for (const listener of record.listeners) listener(text);
}

function finish(record, status, exitCode) {
  record.status = status;
  record.exitCode = exitCode;
  record.finishedAt = Date.now();
  trackHistory(record.execId);
  persistOutput(record);
  persistHistoryIndex();
  for (const listener of record.listeners) listener(null);
}

function trackHistory(execId) {
  finishedOrder.push(execId);
  while (finishedOrder.length > HISTORY_LIMIT) {
    const oldest = finishedOrder.shift();
    if (oldest !== execId) {
      executions.delete(oldest);
      deleteOutputFile(oldest);
    }
  }
}

function kill(execId) {
  const record = executions.get(execId);
  if (!record || record.status !== 'running') return false;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(record.pid), '/T', '/F']);
  } else {
    try {
      process.kill(-record.pid, 'SIGTERM');
    } catch {
      record.child.kill('SIGTERM');
    }
  }

  record.status = 'killed';
  record.finishedAt = Date.now();
  trackHistory(record.execId);
  persistOutput(record);
  persistHistoryIndex();
  for (const listener of record.listeners) listener(null);
  return true;
}

function killAll() {
  let count = 0;
  for (const execId of [...executions.keys()]) {
    if (kill(execId)) count++;
  }
  return count;
}

function clearHistory() {
  for (const [execId, record] of executions) {
    if (record.status !== 'running') {
      executions.delete(execId);
      deleteOutputFile(execId);
    }
  }
  finishedOrder.length = 0;
  persistHistoryIndex();
}

function remove(execId) {
  const record = executions.get(execId);
  if (!record || record.status === 'running') return false;
  executions.delete(execId);
  deleteOutputFile(execId);
  const idx = finishedOrder.indexOf(execId);
  if (idx !== -1) finishedOrder.splice(idx, 1);
  persistHistoryIndex();
  return true;
}

function list() {
  return [...executions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => toSummary(r));
}

function get(execId) {
  const record = executions.get(execId);
  return record ? toSummary(record, true) : null;
}

function getRaw(execId) {
  return executions.get(execId);
}

function toSummary(record, includeOutput) {
  const { execId, noteFile, noteTitle, blockIndex, notesFolder, shell, status, pid, startedAt, finishedAt, exitCode, outputChars } = record;
  const summary = { execId, noteFile, noteTitle, blockIndex, notesFolder, shell, status, pid, startedAt, finishedAt, exitCode, outputChars };
  if (includeOutput) summary.output = record.output.join('');
  return summary;
}

function subscribe(execId, listener) {
  const record = executions.get(execId);
  if (!record) return null;
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

module.exports = { createExecution, kill, killAll, list, get, getRaw, subscribe, clearHistory, remove, sendInput, closeInput, ptyAvailable: !!pty };
