const noteListItemsEl = document.getElementById('note-list-items');
const noteItemsEl = document.getElementById('note-items');
const noteToolbarEl = document.getElementById('note-toolbar');
const currentFilenameEl = document.getElementById('current-filename');
const procTableBody = document.querySelector('#proc-table tbody');
const runningBadge = document.getElementById('running-badge');

const SHELLS = ['powershell', 'cmd', 'bash', 'gitbash'];
const MAX_CLIENT_OUTPUT_CHARS = 1_000_000; // cap displayed output; full history stays on the server
const toastContainer = document.getElementById('toast-container');

function showToast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, 2500);
}

let currentFile = null;
let currentItems = null; // in-memory editable model for the open note
let currentNotesFolder = null; // absolute path of the active notes folder
let defaultNotesFolder = null; // fallback folder the "reset" button restores
let serverStartTime = 0; // used to scope status indicators to executions from this server session only

// ---- meta (version, license, author) + notes folders ----
// Two independent notions of "notes folder":
// - current working folder: set via the sidebar's Open button, remembered and
//   reopened automatically next launch as long as it still exists. Also shown
//   (read-only, with a reset-to-default button) in Settings.
// - default folder: a fallback used only the first time shellnote runs, or if
//   the remembered working folder above is missing.
async function loadMeta() {
  const meta = await fetch('/api/meta').then((r) => r.json());
  document.getElementById('app-version').textContent = `v${meta.version}`;
  document.getElementById('header-meta').textContent = `${meta.license} License · ${meta.author}`;
  serverStartTime = meta.serverStartTime || 0;
  defaultNotesFolder = meta.defaultNotesFolder;
  updateCurrentFolderInfo(meta.notesFolder, meta.isDefaultFolder);
  updateAppDataFolderInfo(meta.appDataDir, meta.isDefaultAppDataDir);
}

function updateCurrentFolderInfo(folderPath, isDefault) {
  currentNotesFolder = folderPath;
  const label = document.getElementById('notes-folder-label');
  label.textContent = isDefault ? `${folderPath} (default)` : folderPath;
  label.title = folderPath;

  document.getElementById('settings-notes-folder-label').textContent = folderPath;
  document.getElementById('settings-notes-folder-reset-btn').classList.toggle('hidden', isDefault);
}

function updateAppDataFolderInfo(folderPath, isDefault) {
  document.getElementById('app-data-folder-label').textContent = isDefault ? `${folderPath} (default)` : folderPath;
  document.getElementById('app-data-folder-reset-btn').classList.toggle('hidden', isDefault);
}

document.getElementById('open-folder-btn').addEventListener('click', async () => {
  try {
    const browsed = await fetch('/api/notes-folder/browse', { method: 'POST' }).then(assertOk).then((r) => r.json());
    if (!browsed.path) return; // user cancelled the dialog
    const meta = await fetch('/api/notes-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: browsed.path }),
    }).then(assertOk).then((r) => r.json());
    updateCurrentFolderInfo(meta.path, false);
    currentFile = null;
    await loadNoteList();
    showToast(`Notes folder set to "${meta.path}"`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---- settings modal ----
const settingsModal = document.getElementById('settings-modal');

function openSettings() {
  settingsModal.classList.remove('hidden');
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

document.getElementById('settings-notes-folder-reset-btn').addEventListener('click', async () => {
  try {
    const meta = await fetch('/api/notes-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: defaultNotesFolder }),
    }).then(assertOk).then((r) => r.json());
    updateCurrentFolderInfo(meta.path, true);
    currentFile = null;
    await loadNoteList();
    showToast('Notes folder reset to default');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('app-data-folder-browse-btn').addEventListener('click', async () => {
  try {
    const browsed = await fetch('/api/app-data-folder/browse', { method: 'POST' }).then(assertOk).then((r) => r.json());
    if (!browsed.path) return; // user cancelled the dialog
    const meta = await fetch('/api/app-data-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: browsed.path }),
    }).then(assertOk).then((r) => r.json());
    updateAppDataFolderInfo(meta.path, false);
    showToast(`App data folder set to "${meta.path}"`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('app-data-folder-reset-btn').addEventListener('click', async () => {
  try {
    const meta = await fetch('/api/app-data-folder/reset', { method: 'POST' }).then(assertOk).then((r) => r.json());
    updateAppDataFolderInfo(meta.path, true);
    showToast('App data folder reset to default');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('clear-app-data-btn').addEventListener('click', async () => {
  if (!confirm('Reset all app settings (app data folder, current working folder, and default notes folder) back to defaults? Your notes are never touched.')) return;
  try {
    const result = await fetch('/api/app-data/clear', { method: 'POST' }).then(assertOk).then((r) => r.json());
    defaultNotesFolder = result.defaultNotesFolder;
    updateCurrentFolderInfo(result.notesFolder, true);
    updateAppDataFolderInfo(result.appDataDir, true);
    currentFile = null;
    await loadNoteList();
    showToast('App data cleared and reset to defaults');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---- sidebar toggle (persisted like VS Code's) ----
const notesViewEl = document.getElementById('notes-view');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');

function setSidebarCollapsed(collapsed) {
  notesViewEl.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtn.classList.toggle('active', !collapsed);
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
}

sidebarToggleBtn.addEventListener('click', () => {
  setSidebarCollapsed(!notesViewEl.classList.contains('sidebar-collapsed'));
});

setSidebarCollapsed(localStorage.getItem('sidebarCollapsed') === '1');

// ---- dark/light theme toggle (persisted) ----
const themeToggleBtn = document.getElementById('theme-toggle-btn');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  setTheme(current === 'light' ? 'dark' : 'light');
});

setTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');

// ---- raw markdown editor mode (persisted, alongside sidebar/theme) ----
const rawModeToggleBtn = document.getElementById('raw-mode-toggle-btn');
const rawEditorEl = document.getElementById('raw-note-editor');
const addTextBtn = document.getElementById('add-text-btn');
const addBlockBtn = document.getElementById('add-block-btn');
let rawMode = localStorage.getItem('rawMode') === '1';
rawModeToggleBtn.classList.toggle('active', rawMode);

rawEditorEl.addEventListener('input', () => markDirty());

// Switches which editor is shown for the currently open note. Never touches
// executions — a running process is tracked server-side by execId regardless
// of which view (or neither) currently displays its block.
function refreshEditorView() {
  if (rawMode) {
    rawEditorEl.value = serializeItems(currentItems);
    rawEditorEl.classList.remove('hidden');
    noteItemsEl.classList.add('hidden');
    addTextBtn.classList.add('hidden');
    addBlockBtn.classList.add('hidden');
  } else {
    renderNoteItems();
    noteItemsEl.classList.remove('hidden');
    rawEditorEl.classList.add('hidden');
    addTextBtn.classList.remove('hidden');
    addBlockBtn.classList.remove('hidden');
  }
}

async function setRawMode(on) {
  if (on === rawMode) return;
  if (!on) {
    // Leaving raw mode: re-parse the edited text back into the block model, then
    // reconnect any still-running executions the same way a fresh note load does.
    currentItems = parseMarkdownToItems(rawEditorEl.value);
    const execs = await fetch('/api/executions').then((r) => r.json());
    reconcileRunningExecs(currentItems, execs, currentFile);
  }
  rawMode = on;
  localStorage.setItem('rawMode', rawMode ? '1' : '0');
  rawModeToggleBtn.classList.toggle('active', rawMode);
  refreshEditorView();
}

rawModeToggleBtn.addEventListener('click', () => {
  if (!currentItems) return;
  setRawMode(!rawMode);
});

// ---- dirty tracking (Save button only highlights when the content actually
// differs from what's on disk — e.g. typing a character and then backspacing
// it back out should not leave Save highlighted) ----
const saveBtn = document.getElementById('save-btn');
let isDirty = false;
let originalContent = '';

function markDirty() {
  isDirty = currentContent() !== originalContent;
  saveBtn.classList.toggle('primary', isDirty);
}

function markClean() {
  originalContent = currentContent();
  isDirty = false;
  saveBtn.classList.remove('primary');
}

// ---- drag & drop reordering ----
let dragSourceItem = null;

function attachDragHandlers(wrap, item, handle) {
  handle.draggable = true;
  handle.addEventListener('dragstart', (e) => {
    dragSourceItem = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    wrap.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    wrap.classList.remove('dragging');
    noteItemsEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    dragSourceItem = null;
  });

  wrap.addEventListener('dragover', (e) => {
    if (!dragSourceItem || dragSourceItem === item) return;
    e.preventDefault();
    wrap.classList.add('drag-over');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drag-over');
    if (!dragSourceItem || dragSourceItem === item) return;
    const fromIndex = currentItems.indexOf(dragSourceItem);
    const toIndex = currentItems.indexOf(item);
    if (fromIndex === -1 || toIndex === -1) return;
    currentItems.splice(fromIndex, 1);
    currentItems.splice(toIndex, 0, dragSourceItem);
    dragSourceItem = null;
    renderNoteItems();
    markDirty();
  });
}

// ---- tabs ----
function activateTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `${tabName}-view`));
  if (tabName === 'processes') refreshProcesses();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ---- minimal markdown rendering (view mode) ----
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdownInline(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  const html = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push('<p>' + paragraph.map(renderMarkdownInline).join('<br>') + '</p>');
      paragraph = [];
    }
  };
  lines.forEach((line) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushParagraph();
      const level = h[1].length;
      html.push(`<h${level}>${renderMarkdownInline(h[2])}</h${level}>`);
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  });
  flushParagraph();
  return html.join('\n');
}

// ---- serialization (items <-> markdown text) ----
// Each item's own text is trimmed before joining — otherwise a prose chunk that
// already ends in blank lines (common after a round trip through the parser)
// would pick up an extra '\n\n' on top of them every time this runs, and the
// gap between sections would grow a little more on every save/toggle.
function serializeItems(items) {
  return items
    .map((item) => (item.type === 'prose' ? item.text.trim() : '```' + item.shell + '\n' + item.code + '\n```'))
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim() + '\n';
}

// Mirrors src/noteParser.js's fence-scanning logic client-side, so the raw
// editor can flip back to block view instantly without a round trip.
function parseMarkdownToItems(raw) {
  const lines = raw.split(/\r?\n/);
  const items = [];
  let proseBuffer = [];
  let blockIndex = 0;
  let i = 0;

  const flushProse = () => {
    if (proseBuffer.length) {
      items.push({ type: 'prose', text: proseBuffer.join('\n') });
      proseBuffer = [];
    }
  };

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```(\w+)\s*$/);
    if (fenceMatch && SHELLS.includes(fenceMatch[1])) {
      flushProse();
      const shell = fenceMatch[1];
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      items.push({ type: 'block', index: blockIndex++, shell, code: codeLines.join('\n') });
      i++;
      continue;
    }
    proseBuffer.push(lines[i]);
    i++;
  }
  flushProse();
  return items;
}

// Executions live server-side keyed by execId, independent of note content —
// removing/reordering blocks (in either view) never touches a running process,
// it only affects whether the note UI still shows a live link back to it.
function reconcileRunningExecs(items, execs, file) {
  execs
    .filter((ex) => ex.status === 'running' && ex.noteFile === file)
    .forEach((ex) => {
      const match = items.find((item) => item.type === 'block' && item.index === ex.blockIndex);
      if (match) match.runningExecId = ex.execId;
    });
}

// ---- note list ----
async function loadNoteList(selectFile) {
  const notes = await fetch('/api/notes').then((r) => r.json());
  const files = notes.map((n) => n.file);
  noteListItemsEl.innerHTML = '';
  notes.forEach(({ file, path }) => {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.dataset.file = file;
    item.title = path;
    item.addEventListener('click', () => selectNote(file));

    const dot = document.createElement('span');
    dot.className = 'status-dot note-status-dot';
    item.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'note-name';
    nameSpan.textContent = file;
    item.appendChild(nameSpan);

    noteListItemsEl.appendChild(item);
  });
  updateStatusIndicators();
  markActiveInList(selectFile || (files.includes(currentFile) ? currentFile : files[0]));
  if (!files.length) {
    currentFile = null;
    currentItems = null;
    noteToolbarEl.classList.add('hidden');
    noteItemsEl.classList.remove('hidden');
    noteItemsEl.innerHTML = '<p class="empty">No notes yet — create one.</p>';
    rawEditorEl.classList.add('hidden');
    return;
  }
  const toSelect = selectFile || (files.includes(currentFile) ? currentFile : files[0]);
  await selectNote(toSelect);
}

function markActiveInList(file) {
  [...noteListItemsEl.children].forEach((el) => el.classList.toggle('active', el.textContent === file));
}

async function selectNote(file) {
  currentFile = file;
  markActiveInList(file);
  const [note, execs] = await Promise.all([
    fetch(`/api/notes/${encodeURIComponent(file)}`).then((r) => r.json()),
    fetch('/api/executions').then((r) => r.json()),
  ]);
  currentItems = note.items;
  // Blocks are re-rendered from scratch on every note load, which would otherwise
  // orphan any execution that's still running for this note — reconnect by
  // matching the server's running executions back onto the freshly loaded blocks.
  reconcileRunningExecs(currentItems, execs, file);
  noteToolbarEl.classList.remove('hidden');
  currentFilenameEl.textContent = file;
  refreshEditorView();
  markClean();
}

// ---- rendering ----
function renderNoteItems() {
  noteItemsEl.innerHTML = '';
  if (!currentItems.length) {
    noteItemsEl.innerHTML = '<p class="empty">Empty note — add text or a code block.</p>';
    return;
  }
  let blockCounter = 0;
  currentItems.forEach((item) => {
    if (item.type === 'prose') {
      noteItemsEl.appendChild(renderProse(item));
    } else {
      item.index = blockCounter++;
      noteItemsEl.appendChild(renderBlock(item));
    }
  });
}

function removeItem(item) {
  currentItems = currentItems.filter((i) => i !== item);
  renderNoteItems();
  markDirty();
  showToast(item.type === 'block' ? 'Code block removed' : 'Text removed');
}

function autoRows(text) {
  return Math.min(20, Math.max(2, (text || '').split('\n').length));
}

function renderProse(item) {
  const wrap = document.createElement('div');
  wrap.className = 'prose';

  const bar = document.createElement('div');
  bar.className = 'block-header';
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  const label = document.createElement('span');
  label.textContent = 'text';
  bar.append(handle, label);
  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn push-right';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => removeItem(item));
  bar.appendChild(removeBtn);
  attachDragHandlers(wrap, item, handle);

  const view = document.createElement('div');
  view.className = 'prose-view';

  const textarea = document.createElement('textarea');
  textarea.className = 'prose-edit hidden';
  textarea.addEventListener('input', () => { item.text = textarea.value; markDirty(); });

  function renderView() {
    view.innerHTML = item.text.trim() ? renderMarkdown(item.text) : '<p class="empty-hint">Click to add text…</p>';
  }

  function setEditing(on) {
    if (on) {
      textarea.value = item.text;
      textarea.rows = autoRows(item.text);
      view.classList.add('hidden');
      textarea.classList.remove('hidden');
      textarea.focus();
    } else {
      textarea.classList.add('hidden');
      view.classList.remove('hidden');
      renderView();
    }
  }

  view.addEventListener('click', () => setEditing(true));
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) setEditing(false);
  });

  renderView();
  wrap.append(bar, view, textarea);

  if (item._justAdded) {
    delete item._justAdded;
    setEditing(true);
  }

  return wrap;
}

function renderBlock(block) {
  const wrap = document.createElement('div');
  wrap.className = 'block';
  wrap.dataset.blockIndex = block.index;

  const header = document.createElement('div');
  header.className = 'block-header';

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

  const dot = document.createElement('span');
  dot.className = 'status-dot';

  const shellLabel = document.createElement('span');
  shellLabel.className = `shell-badge ${block.shell}`;
  shellLabel.textContent = block.shell;

  const shellSelect = document.createElement('select');
  shellSelect.className = 'shell-select hidden';
  SHELLS.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    if (s === block.shell) opt.selected = true;
    shellSelect.appendChild(opt);
  });
  shellSelect.addEventListener('change', () => {
    block.shell = shellSelect.value;
    shellLabel.className = `shell-badge ${block.shell}`;
    shellLabel.textContent = block.shell;
    markDirty();
  });

  const runBtn = document.createElement('button');
  runBtn.className = 'run-btn';
  runBtn.innerHTML = '<span class="play-icon">&#9654;</span> Run';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn push-right';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => removeItem(block));

  header.append(handle, dot, shellLabel, shellSelect, runBtn, removeBtn);
  attachDragHandlers(wrap, block, handle);

  const codeView = document.createElement('pre');
  codeView.className = 'code';
  const codeViewInner = document.createElement('code');
  codeView.appendChild(codeViewInner);

  const codeArea = document.createElement('textarea');
  codeArea.className = 'code-edit hidden';
  codeArea.addEventListener('input', () => { block.code = codeArea.value; markDirty(); });

  function renderCodeView() {
    codeViewInner.textContent = block.code || ' ';
  }

  function setEditing(on) {
    if (on) {
      codeArea.value = block.code;
      codeArea.rows = autoRows(block.code);
      codeView.classList.add('hidden');
      shellLabel.classList.add('hidden');
      codeArea.classList.remove('hidden');
      shellSelect.classList.remove('hidden');
      codeArea.focus();
    } else {
      codeArea.classList.add('hidden');
      shellSelect.classList.add('hidden');
      codeView.classList.remove('hidden');
      shellLabel.classList.remove('hidden');
      renderCodeView();
    }
  }

  codeView.addEventListener('click', () => setEditing(true));
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) setEditing(false);
  });

  const outputPanel = document.createElement('div');
  outputPanel.className = 'output-panel hidden';
  const outputPre = document.createElement('pre');
  outputPre.className = 'output';
  outputPanel.appendChild(outputPre);

  renderCodeView();
  wrap.append(header, codeView, codeArea, outputPanel);

  if (block._justAdded) {
    delete block._justAdded;
    setEditing(true);
  }

  let fullOutput = '';
  let collapsed = true;
  let killBtn = null;
  let toggleBtn = null;
  let popoutBtn = null;
  let clearBtn = null;

  function renderOutput() {
    outputPre.textContent = collapsed ? fullOutput.split('\n').slice(-10).join('\n') : fullOutput;
    outputPre.scrollTop = outputPre.scrollHeight;
  }

  // A fast/verbose long-running process can emit SSE messages far faster than the
  // browser can usefully repaint. Cap how much text we hold client-side (the full
  // history is still on the server, bounded the same way) and coalesce renders
  // instead of re-rendering on every message, so a burst of output can't stall the
  // tab. Uses setTimeout, not requestAnimationFrame — RAF is fully paused by
  // browsers for background/inactive tabs, which would freeze the display exactly
  // when a long job is running in a tab the user has switched away from.
  let renderScheduled = false;
  function scheduleRenderOutput() {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      renderOutput();
    }, 150);
  }

  function appendFullOutput(text) {
    fullOutput += text;
    if (fullOutput.length > MAX_CLIENT_OUTPUT_CHARS) fullOutput = fullOutput.slice(-MAX_CLIENT_OUTPUT_CHARS);
  }

  function ensureExecButtons() {
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.className = 'toggle-btn';
      toggleBtn.textContent = 'Show more';
      toggleBtn.addEventListener('click', () => {
        collapsed = !collapsed;
        toggleBtn.textContent = collapsed ? 'Show more' : 'Show less';
        renderOutput();
      });
      header.insertBefore(toggleBtn, removeBtn);
    }
    if (!popoutBtn) {
      popoutBtn = document.createElement('button');
      popoutBtn.className = 'popout-btn';
      popoutBtn.textContent = 'Pop out';
      header.insertBefore(popoutBtn, removeBtn);
    }
    if (!killBtn) {
      killBtn = document.createElement('button');
      killBtn.className = 'kill-btn';
      killBtn.textContent = 'Kill';
      header.insertBefore(killBtn, removeBtn);
    }
    if (!clearBtn) {
      // Takes over "push-right" from Remove so the two sit together at the far
      // right of the header, instead of Remove alone floating off on its own.
      clearBtn = document.createElement('button');
      clearBtn.className = 'clear-output-btn push-right';
      clearBtn.textContent = 'Clear output';
      clearBtn.addEventListener('click', () => {
        fullOutput = '';
        renderOutput();
      });
      removeBtn.classList.remove('push-right');
      header.insertBefore(clearBtn, removeBtn);
    }
    killBtn.classList.remove('hidden');
  }

  function attachToExecution(execId) {
    ensureExecButtons();
    killBtn.onclick = async () => {
      const res = await fetch(`/api/executions/${execId}/kill`, { method: 'POST' });
      showToast(res.ok ? 'Process killed' : 'Failed to kill process', res.ok ? 'success' : 'error');
    };
    popoutBtn.onclick = () => window.open(`/output.html?execId=${execId}`, '_blank', 'width=720,height=520');

    const es = new EventSource(`/api/executions/${execId}/stream`);
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.snapshot !== undefined) fullOutput = msg.snapshot.slice(-MAX_CLIENT_OUTPUT_CHARS);
      else if (msg.chunk !== undefined) appendFullOutput(msg.chunk);
      scheduleRenderOutput();
    };
    es.addEventListener('done', (e) => {
      dot.className = `status-dot ${JSON.parse(e.data).status}`;
      killBtn.classList.add('hidden');
      if (block.runningExecId === execId) delete block.runningExecId;
      renderOutput();
      es.close();
    });
    es.onerror = () => es.close();
  }

  runBtn.addEventListener('click', async () => {
    setEditing(false);
    outputPanel.classList.remove('hidden');
    fullOutput = '';
    collapsed = true;
    renderOutput();
    dot.className = 'status-dot running';
    ensureExecButtons();

    const { execId } = await fetch('/api/blocks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shell: block.shell,
        code: block.code,
        noteFile: currentFile,
        noteTitle: currentFile,
        blockIndex: block.index,
      }),
    }).then((r) => r.json());

    block.runningExecId = execId;
    attachToExecution(execId);
  });

  if (block.runningExecId) {
    outputPanel.classList.remove('hidden');
    dot.className = 'status-dot running';
    attachToExecution(block.runningExecId);
  }

  return wrap;
}

// ---- toolbar actions ----
document.getElementById('reload-notes-btn').addEventListener('click', async () => {
  try {
    await loadNoteList(currentFile);
    showToast('Notes list refreshed');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('new-note-btn').addEventListener('click', async () => {
  let name = prompt('New note filename:', 'untitled.md');
  if (!name) return;
  if (!name.toLowerCase().endsWith('.md')) name += '.md';
  const title = name.replace(/\.md$/i, '');
  try {
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: name, content: `# ${title}\n` }),
    }).then(assertOk);
    await loadNoteList(name);
    showToast(`Created "${name}"`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('add-text-btn').addEventListener('click', () => {
  currentItems.push({ type: 'prose', text: '', _justAdded: true });
  renderNoteItems();
  markDirty();
});

document.getElementById('add-block-btn').addEventListener('click', () => {
  currentItems.push({ type: 'block', shell: 'powershell', code: '', _justAdded: true });
  renderNoteItems();
  markDirty();
});

function currentContent() {
  return rawMode ? rawEditorEl.value : serializeItems(currentItems);
}

saveBtn.addEventListener('click', async () => {
  try {
    const content = currentContent();
    await fetch(`/api/notes/${encodeURIComponent(currentFile)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then(assertOk);
    if (rawMode) currentItems = parseMarkdownToItems(content);
    markClean();
    showToast('Saved successfully');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('save-as-btn').addEventListener('click', async () => {
  let name = prompt('Save as filename:', currentFile);
  if (!name) return;
  if (!name.toLowerCase().endsWith('.md')) name += '.md';
  try {
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: name, content: currentContent() }),
    }).then(assertOk);
    await loadNoteList(name);
    showToast(`Saved as "${name}"`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

currentFilenameEl.addEventListener('click', () => {
  if (!currentFile) return;
  const original = currentFile;

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'current-filename';
  input.className = 'filename-input';
  input.value = original;
  currentFilenameEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    input.replaceWith(currentFilenameEl);

    if (!commit) return;
    let newName = input.value.trim();
    if (!newName || newName === original) return;
    if (!newName.toLowerCase().endsWith('.md')) newName += '.md';
    try {
      await fetch(`/api/notes/${encodeURIComponent(original)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      }).then(assertOk);
      await loadNoteList(newName);
      showToast(`Renamed to "${newName}"`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
});

document.getElementById('delete-note-btn').addEventListener('click', async () => {
  if (!currentFile || !confirm(`Delete "${currentFile}"? This cannot be undone.`)) return;
  const deletedFile = currentFile;
  try {
    await fetch(`/api/notes/${encodeURIComponent(currentFile)}`, { method: 'DELETE' }).then(assertOk);
    currentFile = null;
    await loadNoteList();
    showToast(`Deleted "${deletedFile}"`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function assertOk(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res;
}

// ---- processes tab ----
function formatDuration(ms) {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - totalMinutes * 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = n;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

let latestExecs = [];
let procSortColumn = 'started';
let procSortDir = 'desc'; // default: newest first

const columnSorters = {
  note: (ex) => (ex.noteTitle || ex.noteFile || '').toLowerCase(),
  block: (ex) => ex.blockIndex,
  shell: (ex) => (ex.shell || '').toLowerCase(),
  status: (ex) => ex.status,
  started: (ex) => ex.startedAt,
  duration: (ex) => (ex.finishedAt || Date.now()) - ex.startedAt,
  logsize: (ex) => ex.outputChars || 0,
};

document.querySelectorAll('#proc-table thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    procSortDir = procSortColumn === col ? (procSortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    procSortColumn = col;
    renderProcTable();
  });
});

document.getElementById('clear-history-btn').addEventListener('click', async () => {
  await fetch('/api/executions/clear', { method: 'POST' });
  await refreshProcesses();
  showToast('Finished processes cleared');
});

document.getElementById('kill-all-btn').addEventListener('click', async () => {
  if (!confirm('Kill all running processes?')) return;
  const { count } = await fetch('/api/executions/kill-all', { method: 'POST' }).then((r) => r.json());
  await refreshProcesses();
  showToast(count ? `Killed ${count} running process(es)` : 'No running processes');
});

async function refreshProcesses() {
  latestExecs = await fetch('/api/executions').then((r) => r.json());
  renderProcTable();
}

function renderProcTable() {
  const sorter = columnSorters[procSortColumn];
  const sorted = [...latestExecs].sort((a, b) => {
    const va = sorter(a);
    const vb = sorter(b);
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return procSortDir === 'asc' ? cmp : -cmp;
  });

  procTableBody.innerHTML = '';
  let runningCount = 0;

  sorted.forEach((ex) => {
    if (ex.status === 'running') runningCount++;
    const tr = document.createElement('tr');

    const duration = (ex.finishedAt || Date.now()) - ex.startedAt;
    const durationStr = formatDuration(duration);
    const startedAt = new Date(ex.startedAt);
    const startedStr = `${startedAt.toLocaleDateString()} ${startedAt.toLocaleTimeString()}`;

    tr.innerHTML = `
      <td></td>
      <td>#${ex.blockIndex}</td>
      <td>${ex.shell}</td>
      <td><span class="status-dot ${ex.status}"></span> <span class="status-text ${ex.status}">${ex.status}</span></td>
      <td>${startedStr}</td>
      <td>${durationStr}</td>
      <td>${formatBytes(ex.outputChars)}</td>
      <td></td>
    `;

    const noteLink = document.createElement('a');
    noteLink.href = '#';
    noteLink.className = 'note-link';
    noteLink.textContent = ex.noteTitle || ex.noteFile || '-';
    noteLink.title = `Go to block #${ex.blockIndex} in ${ex.noteFile}`;
    noteLink.addEventListener('click', async (e) => {
      e.preventDefault();
      // The note it ran in might belong to a different notes folder than the one
      // currently open — resolving noteFile against the wrong folder would silently
      // show the wrong file (or a same-named unrelated one), so check first.
      if (ex.notesFolder && currentNotesFolder && ex.notesFolder !== currentNotesFolder) {
        showToast(`This ran in a different notes folder ("${ex.notesFolder}") — open that folder to view its block.`, 'error');
        return;
      }
      activateTab('notes');
      if (currentFile !== ex.noteFile) await selectNote(ex.noteFile);
      const target = noteItemsEl.querySelector(`.block[data-block-index="${ex.blockIndex}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash-highlight');
        setTimeout(() => target.classList.remove('flash-highlight'), 1500);
      } else {
        showToast('That block no longer exists in the note', 'error');
      }
    });
    tr.children[0].appendChild(noteLink);

    const viewBtn = document.createElement('button');
    viewBtn.className = 'popout-btn';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => window.open(`/output.html?execId=${ex.execId}`, '_blank', 'width=720,height=520'));
    tr.lastElementChild.appendChild(viewBtn);

    if (ex.status === 'running') {
      const killBtn = document.createElement('button');
      killBtn.className = 'kill-btn';
      killBtn.textContent = 'Kill';
      killBtn.addEventListener('click', async () => {
        const res = await fetch(`/api/executions/${ex.execId}/kill`, { method: 'POST' });
        showToast(res.ok ? 'Process killed' : 'Failed to kill process', res.ok ? 'success' : 'error');
      });
      tr.lastElementChild.appendChild(killBtn);
    } else {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        const res = await fetch(`/api/executions/${ex.execId}`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Execution removed');
          await refreshProcesses();
        } else {
          showToast('Failed to remove execution', 'error');
        }
      });
      tr.lastElementChild.appendChild(removeBtn);
    }

    procTableBody.appendChild(tr);
  });

  runningBadge.textContent = String(runningCount);
  runningBadge.classList.toggle('hidden', runningCount === 0);
  updateSortIndicators();
  updateStatusIndicators();
}

function computeAggregateStatus(execs) {
  if (execs.some((ex) => ex.status === 'running')) return 'running';
  if (execs.some((ex) => ex.status === 'failed')) return 'failed';
  if (execs.some((ex) => ex.status === 'success')) return 'success';
  return ''; // grey — nothing, or only killed executions
}

function updateStatusIndicators() {
  const sessionExecs = latestExecs.filter((ex) => ex.startedAt >= serverStartTime);

  const globalDot = document.getElementById('session-status-dot');
  if (globalDot) globalDot.className = `status-dot ${computeAggregateStatus(sessionExecs)}`.trim();

  const byFile = new Map();
  sessionExecs.forEach((ex) => {
    if (!byFile.has(ex.noteFile)) byFile.set(ex.noteFile, []);
    byFile.get(ex.noteFile).push(ex);
  });

  document.querySelectorAll('#note-list-items .note-item').forEach((item) => {
    const dot = item.querySelector('.note-status-dot');
    if (!dot) return;
    const status = computeAggregateStatus(byFile.get(item.dataset.file) || []);
    dot.className = `status-dot note-status-dot ${status}`.trim();
  });
}

function updateSortIndicators() {
  document.querySelectorAll('#proc-table thead th[data-sort]').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === procSortColumn) th.classList.add(procSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

setInterval(refreshProcesses, 2000);
loadMeta();
loadNoteList();
refreshProcesses();
