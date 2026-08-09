const noteListItemsEl = document.getElementById('note-list-items');
const noteItemsEl = document.getElementById('note-items');
const noteContentEl = document.getElementById('note-content');
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
let runRoot = ''; // where code blocks run, before any in-note cd simulation
let homeDir = ''; // server user's home — resolves `cd ~` in the cwd simulation
let ptyAvailable = false; // node-pty installed server-side = full terminal input
let defaultShell = 'bash'; // shell a new code block starts as, per the server's OS

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
  homeDir = meta.homeDir || '';
  ptyAvailable = !!meta.ptyAvailable;
  if (meta.defaultShell) defaultShell = meta.defaultShell;
  document.getElementById('help-input-mode').innerHTML = ptyAvailable
    ? 'Input mode: <b>full terminal</b> — node-pty is installed, so programs that insist on a real TTY before prompting (ssh, sudo) work too.'
    : 'Input mode: <b>basic</b> — line-based prompts work as-is. Programs that refuse to prompt without a real TTY (ssh, sudo) need the optional <code>node-pty</code> module: run <code>npm install node-pty</code> in the shellnote folder and restart the server.';
  updateCurrentFolderInfo(meta.notesFolder, meta.isDefaultFolder);
  updateAppDataFolderInfo(meta.appDataDir, meta.isDefaultAppDataDir);
  updateRunRootInfo(meta.runRoot, meta.isDefaultRunRoot);
}

// Paths sit inside a <bdi> so they keep their own left-to-right order in the
// labels that ellipsize from the left — see the CSS note on #notes-folder-label.
function setPathText(el, text) {
  el.textContent = '';
  const bdi = document.createElement('bdi');
  bdi.textContent = text;
  el.appendChild(bdi);
}

function updateCurrentFolderInfo(folderPath, isDefault) {
  currentNotesFolder = folderPath;
  const label = document.getElementById('notes-folder-label');
  setPathText(label, isDefault ? `${folderPath} (default)` : folderPath);
  label.title = folderPath;

  document.getElementById('settings-notes-folder-label').textContent = folderPath;
  document.getElementById('settings-notes-folder-reset-btn').classList.toggle('hidden', isDefault);
}

function updateAppDataFolderInfo(folderPath, isDefault) {
  document.getElementById('app-data-folder-label').textContent = isDefault ? `${folderPath} (default)` : folderPath;
  document.getElementById('app-data-folder-reset-btn').classList.toggle('hidden', isDefault);
}

function updateRunRootInfo(folderPath, isDefault) {
  runRoot = folderPath;
  document.getElementById('run-root-label').textContent = isDefault ? `${folderPath} (default)` : folderPath;
  document.getElementById('run-root-reset-btn').classList.toggle('hidden', isDefault);
  updateCwdLabels();
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

// ---- help modal ----
const helpModal = document.getElementById('help-modal');
document.getElementById('help-btn').addEventListener('click', () => helpModal.classList.remove('hidden'));
document.getElementById('help-close-btn').addEventListener('click', () => helpModal.classList.add('hidden'));
helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) helpModal.classList.add('hidden');
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

document.getElementById('run-root-browse-btn').addEventListener('click', async () => {
  try {
    const browsed = await fetch('/api/run-root/browse', { method: 'POST' }).then(assertOk).then((r) => r.json());
    if (!browsed.path) return; // user cancelled the dialog
    const meta = await fetch('/api/run-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: browsed.path }),
    }).then(assertOk).then((r) => r.json());
    updateRunRootInfo(meta.path, false);
    showToast(`Run folder set to "${meta.path}"`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('run-root-reset-btn').addEventListener('click', async () => {
  try {
    const meta = await fetch('/api/run-root/reset', { method: 'POST' }).then(assertOk).then((r) => r.json());
    updateRunRootInfo(meta.path, true);
    showToast('Run folder reset to default');
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
    updateRunRootInfo(result.runRoot, true);
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

function clearDropTargets() {
  noteItemsEl.querySelectorAll('.insert-divider.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

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
    clearDropTargets();
    dragSourceItem = null;
  });
}

// Which boundary (index into currentItems) a pointer position corresponds to:
// before the first item whose midpoint is below the cursor, else the very end.
// Every Y maps to some boundary, so there is no position inside the note area
// that fails to resolve to a drop target.
function boundaryIndexAt(clientY) {
  const els = [...noteItemsEl.querySelectorAll(':scope > .prose, :scope > .block')];
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return els.length;
}

// Drag handling lives on the container, not on individual items. A drop is only
// accepted where the *last* dragover called preventDefault(), so per-item
// handlers left dead zones — the margins between items, the gutter, the area
// below the last item, and the dragged item itself — where releasing silently
// did nothing while the stale highlight still showed a valid-looking target.
noteContentEl.addEventListener('dragover', (e) => {
  if (!dragSourceItem) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropTargets();
  const dividers = noteItemsEl.querySelectorAll(':scope > .insert-divider');
  const divider = dividers[boundaryIndexAt(e.clientY)];
  if (divider) divider.classList.add('drop-target');
});

noteContentEl.addEventListener('dragleave', (e) => {
  if (!noteContentEl.contains(e.relatedTarget)) clearDropTargets();
});

noteContentEl.addEventListener('drop', (e) => {
  if (!dragSourceItem) return;
  e.preventDefault();
  clearDropTargets();
  const fromIndex = currentItems.indexOf(dragSourceItem);
  const boundary = boundaryIndexAt(e.clientY);
  const moved = dragSourceItem;
  dragSourceItem = null;
  // Both boundaries touching the dragged item put it back where it started.
  if (fromIndex === -1 || boundary === fromIndex || boundary === fromIndex + 1) return;
  currentItems.splice(fromIndex, 1);
  currentItems.splice(boundary > fromIndex ? boundary - 1 : boundary, 0, moved);
  renderNoteItems();
  markDirty();
});

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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Notes are local files, but a pasted/shared .md shouldn't be able to smuggle a
// javascript: link into a rendered href.
function safeUrl(u) {
  return /^(https?:|mailto:|#|\/|\.)/i.test(u) ? u : '#';
}

function renderMarkdownInline(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => `<img src="${safeUrl(url)}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

// Block-level constructs beyond headings/paragraphs (lists, quotes, rules,
// non-runnable fenced code) all land here because the parser only extracts
// shell fences into blocks — everything else in the file is "prose" and should
// still read like a normal rendered note.
function renderMarkdown(text) {
  const lines = text.split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let fence = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push('<p>' + paragraph.map(renderMarkdownInline).join('<br>') + '</p>');
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.tag}>` + list.items.map((it) => `<li>${renderMarkdownInline(it)}</li>`).join('') + `</${list.tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      html.push('<blockquote>' + quote.map(renderMarkdownInline).join('<br>') + '</blockquote>');
      quote = [];
    }
  };
  const flushFence = () => {
    if (fence) {
      html.push(`<pre class="md-code"><code>${escapeHtml(fence.lines.join('\n'))}</code></pre>`);
      fence = null;
    }
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  lines.forEach((line) => {
    if (fence) {
      if (/^```/.test(line)) flushFence();
      else fence.lines.push(line);
      return;
    }
    if (/^```/.test(line)) {
      flushAll();
      fence = { lines: [] };
      return;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      html.push(`<h${h[1].length}>${renderMarkdownInline(h[2])}</h${h[1].length}>`);
      return;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      html.push('<hr>');
      return;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushParagraph(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(ul[1]);
      return;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushParagraph(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(ol[1]);
      return;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushParagraph(); flushList();
      quote.push(q[1]);
      return;
    }
    if (line.trim() === '') {
      flushAll();
      return;
    }
    flushList(); flushQuote();
    paragraph.push(line);
  });
  flushAll();
  flushFence(); // unterminated fence at end of a prose chunk still renders as code
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

  // Mirrors the server parser: whitespace-only runs between fences are not
  // content, so don't turn them into empty prose items.
  const flushProse = () => {
    if (proseBuffer.length && proseBuffer.join('\n').trim()) {
      items.push({ type: 'prose', text: proseBuffer.join('\n') });
    }
    proseBuffer = [];
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
let noteList = []; // [{ file, path }] in sidebar order, custom or A–Z

// The sort button is only actionable when the sidebar is out of A–Z order, so
// it doubles as an indicator that a hand-arranged order is in effect.
function isAlphabetical(notes) {
  const alpha = [...notes].sort((a, b) => a.file.localeCompare(b.file));
  return notes.every((n, i) => n.file === alpha[i].file);
}

// Sorting resets the whole sidebar, so the button stays available while either
// section is hand-arranged.
function refreshSortButtonState() {
  const inOrder = isAlphabetical(noteList) && isAlphabetical(starredNotes());
  document.getElementById('sort-notes-btn').disabled = inOrder;
}

// Quick access keeps its own arrangement — the stored order of starred files —
// rather than mirroring the list below it.
function starredNotes() {
  return noteList.filter((n) => n.starred).sort((a, b) => a.starIndex - b.starIndex);
}

function saveStarredOrder() {
  return fetch('/api/starred/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: starredNotes().map((n) => n.file) }),
  });
}

function saveNoteOrder() {
  return fetch('/api/notes-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: noteList.map((n) => n.file) }),
  });
}

const ICON_STAR = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"/></svg>';

async function toggleStar(file, starred) {
  const note = noteList.find((n) => n.file === file);
  if (note) {
    note.starred = starred;
    // Match the server: a newly starred note joins the end of Quick access.
    note.starIndex = starred ? Math.max(-1, ...noteList.map((n) => n.starIndex)) + 1 : -1;
  }
  renderNoteList();
  markActiveInList(currentFile);
  try {
    await fetch('/api/starred', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, starred }),
    }).then(assertOk);
  } catch (err) {
    showToast(`Could not save starred note: ${err.message}`, 'error');
  }
}

// One builder for both lists, so a starred note behaves identically whether
// it's clicked in the starred section or in the full list below it.
function createNoteItem({ file, path, starred }, { list }) {
  const item = document.createElement('div');
  item.className = 'note-item';
  item.dataset.file = file;
  item.title = path;
  item.addEventListener('click', () => selectNote(file));

  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    dragSourceNote = file;
    dragSourceList = list;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', file);
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    clearNoteDropMarkers();
    dragSourceNote = null;
    dragSourceList = null;
  });

  const dot = document.createElement('span');
  dot.className = 'status-dot note-status-dot';
  item.appendChild(dot);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'note-name';
  nameSpan.textContent = file;
  item.appendChild(nameSpan);

  // The star is the gesture; the section it feeds is labelled "Quick access"
  // in the UI, which is what the tooltips name.
  const star = document.createElement('button');
  star.className = `note-star${starred ? ' starred' : ''}`;
  star.innerHTML = ICON_STAR;
  star.title = starred ? 'Remove from Quick access' : 'Add to Quick access';
  star.addEventListener('click', (e) => {
    e.stopPropagation(); // starring a note shouldn't also open it
    toggleStar(file, !starred);
  });
  item.appendChild(star);

  return item;
}

// The starred section ("Quick access" in the UI) is a filtered view of the same
// list, so whatever order the notes are in — A–Z or hand-arranged — both
// sections follow it.
function renderNoteList() {
  noteListItemsEl.innerHTML = '';
  noteList.forEach((note) => noteListItemsEl.appendChild(createNoteItem(note, { list: noteListItemsEl })));

  const starred = starredNotes();
  const section = document.getElementById('starred-section');
  section.classList.toggle('hidden', starred.length === 0); // nothing starred, nothing to show
  document.getElementById('starred-count').textContent = starred.length || '';
  const starredItemsEl = document.getElementById('starred-items');
  starredItemsEl.innerHTML = '';
  starred.forEach((note) => starredItemsEl.appendChild(createNoteItem(note, { list: starredItemsEl })));

  refreshSortButtonState();
  updateStatusIndicators();
}

// ---- starred section collapse (persisted, like the sidebar and theme) ----
const starredSectionEl = document.getElementById('starred-section');

function setStarredCollapsed(collapsed) {
  starredSectionEl.classList.toggle('collapsed', collapsed);
  localStorage.setItem('starredCollapsed', collapsed ? '1' : '0');
}

document.getElementById('starred-header').addEventListener('click', () => {
  setStarredCollapsed(!starredSectionEl.classList.contains('collapsed'));
});

setStarredCollapsed(localStorage.getItem('starredCollapsed') === '1');

// ---- sidebar drag & drop ----
let dragSourceNote = null;
let dragSourceList = null; // the container the drag started in

function clearNoteDropMarkers() {
  document.querySelectorAll('#note-list .drop-before, #note-list .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

// Which slot in a list a pointer position falls at. Bound to the container
// (not each row) so the gaps between rows and the empty space below the last
// one are valid drop targets too, rather than silently rejecting the drop.
function boundaryIn(container, clientY) {
  const rows = [...container.children];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

// Both sections reorder the same way; they differ only in which arrangement
// gets rewritten. A drag is confined to the list it started in — moving a row
// between sections would mean starring/unstarring, which the star already does.
function wireListReordering(container, { reorder, save, label }) {
  container.addEventListener('dragover', (e) => {
    if (!dragSourceNote || dragSourceList !== container) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearNoteDropMarkers();
    const rows = [...container.children];
    const boundary = boundaryIn(container, e.clientY);
    if (boundary < rows.length) rows[boundary].classList.add('drop-before');
    else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
  });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) clearNoteDropMarkers();
  });

  container.addEventListener('drop', async (e) => {
    if (!dragSourceNote || dragSourceList !== container) return;
    e.preventDefault();
    clearNoteDropMarkers();
    const file = dragSourceNote;
    const boundary = boundaryIn(container, e.clientY);
    dragSourceNote = null;
    dragSourceList = null;
    if (!reorder(file, boundary)) return; // dropped back where it started
    renderNoteList();
    markActiveInList(currentFile);
    try {
      await save().then(assertOk);
    } catch (err) {
      showToast(`Could not save ${label}: ${err.message}`, 'error');
    }
  });
}

// Moves `file` to `boundary` within `list`; returns false when that's a no-op.
function moveWithin(list, file, boundary) {
  const from = list.findIndex((n) => n.file === file);
  if (from === -1 || boundary === from || boundary === from + 1) return false;
  const [moved] = list.splice(from, 1);
  list.splice(boundary > from ? boundary - 1 : boundary, 0, moved);
  return true;
}

wireListReordering(noteListItemsEl, {
  reorder: (file, boundary) => moveWithin(noteList, file, boundary),
  save: saveNoteOrder,
  label: 'note order',
});

wireListReordering(document.getElementById('starred-items'), {
  reorder: (file, boundary) => {
    const starred = starredNotes();
    if (!moveWithin(starred, file, boundary)) return false;
    starred.forEach((n, i) => { n.starIndex = i; }); // starIndex is the Quick access order
    return true;
  },
  save: saveStarredOrder,
  label: 'Quick access order',
});

document.getElementById('sort-notes-btn').addEventListener('click', async () => {
  try {
    await fetch('/api/notes-order/reset', { method: 'POST' }).then(assertOk);
    await loadNoteList(currentFile);
    showToast('Notes sorted A–Z');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadNoteList(selectFile) {
  const notes = await fetch('/api/notes').then((r) => r.json());
  const files = notes.map((n) => n.file);
  noteList = notes;
  renderNoteList();
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

// A starred note appears in both sections, so highlight every row for it.
function markActiveInList(file) {
  document.querySelectorAll('#note-list .note-item')
    .forEach((el) => el.classList.toggle('active', el.dataset.file === file));
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

// ---- working-directory simulation ----
// Each block spawns a fresh shell, so a `cd` never really carries over — but a
// runbook is usually written as if it does. We simulate it: walk the note top
// to bottom, thread the run root through every cd found in block code, and use
// the result both for the per-block folder label and as the cwd sent with Run.
// Pure string work (the client has no filesystem) handling POSIX and Windows
// paths: cd .., absolute paths, drive-root `cd \`, `cd D:\x`, bare `D:`, ~.
function isWindowsPath(p) {
  return /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\');
}

// Collapse . and .. segments of an absolute path; `..` above the root clamps.
function normalizePath(p, win) {
  const sep = win ? '\\' : '/';
  let prefix = '';
  if (win) {
    const m = p.match(/^[a-zA-Z]:/);
    prefix = m ? m[0].toUpperCase() : '';
    p = p.slice(prefix.length);
  }
  const parts = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return win ? prefix + sep + parts.join(sep) : '/' + parts.join(sep);
}

function joinPath(base, rel) {
  const win = isWindowsPath(base);
  return normalizePath(base + (win ? '\\' : '/') + rel, win);
}

// One cd target resolved against `cur`; null means "can't tell" (env vars,
// substitutions) — the simulation then just keeps the current folder.
// `tildeOk`: ~ means home in bash and powershell, but cmd has no ~ at all.
function resolveCdTarget(cur, target, tildeOk) {
  target = target.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!target || /[$%`]/.test(target)) return null;
  if (target === '~') return (tildeOk && homeDir) || null;
  if (/^~[\\/]/.test(target)) return tildeOk && homeDir ? joinPath(homeDir, target.slice(2)) : null;
  if (/^[a-zA-Z]:$/.test(target)) return target.toUpperCase() + '\\'; // bare drive switch
  if (/^[a-zA-Z]:[\\/]/.test(target)) return normalizePath(target, true); // windows absolute
  if (/^[\\/]/.test(target)) {
    // root-relative: the current drive's root on windows, filesystem root otherwise
    if (isWindowsPath(cur)) return normalizePath(cur.slice(0, 2) + target, true);
    return normalizePath(target, false);
  }
  return joinPath(cur, target);
}

// The folder this shell would be in after running this block, starting from
// `cur`. Only forms the block's own shell understands are recognized: `cd /d`,
// `chdir`, and bare drive switches (`D:`) belong to cmd, `Set-Location` and
// drive switches to powershell, case-sensitive `cd`/`pushd` and bare-`cd`-goes-
// home to bash — so e.g. a stray `D:` line in a bash block changes nothing.
function cwdAfterBlock(cur, block) {
  const shell = block.shell;
  const posix = shell === 'bash' || shell === 'gitbash';
  for (const line of (block.code || '').split('\n')) {
    // a cd can hide mid-line: `mkdir x && cd x`
    for (const segment of line.split(/&&|\|\||;/)) {
      const s = segment.trim();
      let m = null;
      if (shell === 'cmd') m = s.match(/^cd\s+\/d\s+(.+)$/i) || s.match(/^(?:cd|chdir|pushd)\s+(.+)$/i);
      else if (shell === 'powershell') m = s.match(/^(?:cd|set-location|pushd)\s+(.+)$/i);
      else m = s.match(/^(?:cd|pushd)\s+(.+)$/); // bash is case-sensitive: `CD x` is not a cd
      if (m) {
        const next = resolveCdTarget(cur, m[1], !posix ? shell === 'powershell' : true);
        if (next) cur = next;
        continue;
      }
      if (posix) {
        if (/^cd$/.test(s) && homeDir) cur = homeDir; // bare `cd` goes home in bash
      } else if (/^[a-zA-Z]:$/.test(s)) {
        cur = s.toUpperCase() + '\\'; // cmd and powershell switch drive on a bare `D:`
      }
    }
  }
  return cur;
}

// Per-block starting folders for the open note, in block order. Each shell
// family is its own lineage: a cd in a cmd block shifts only the cmd blocks
// below it — interleaved bash/powershell blocks keep their own folder, since
// a real cmd cd could never have influenced them.
function effectiveCwds() {
  const cwds = [];
  const perShell = {};
  for (const item of currentItems) {
    if (item.type !== 'block') continue;
    const cur = perShell[item.shell] || runRoot;
    cwds.push(cur);
    perShell[item.shell] = cwdAfterBlock(cur, item);
  }
  return cwds;
}

// Shortens a path in the middle until it fits its box — the start says which
// drive or home it's under, the end says which project, and the middle is the
// part you can afford to lose. The full path stays in the tooltip.
// Binary searches the longest kept length that still fits, so it costs a
// handful of layout reads rather than one per character.
function fitPathLabel(el) {
  const full = el.dataset.path || '';
  el.textContent = full;
  if (!full || !el.clientWidth || el.scrollWidth <= el.clientWidth) return;
  let lo = 1;
  let hi = full.length - 1;
  let best = '…';
  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const candidate = full.slice(0, head) + '…' + (tail ? full.slice(-tail) : '');
    el.textContent = candidate;
    if (el.scrollWidth <= el.clientWidth) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  el.textContent = best;
}

// The room a label gets changes for many reasons — window resize, the sidebar,
// a scrollbar appearing, the extra buttons a block grows once it has run.
// Watching the box itself catches all of them; a resize listener would only
// catch the first. Re-fitting doesn't alter the box (the label is flex-sized),
// so this can't feed back into itself.
const pathLabelObserver = new ResizeObserver((entries) => {
  for (const entry of entries) fitPathLabel(entry.target);
});

function updateCwdLabels() {
  if (!currentItems || !runRoot) return;
  const cwds = effectiveCwds();
  noteItemsEl.querySelectorAll(':scope > .block .cwd-label').forEach((el, i) => {
    el.dataset.path = cwds[i] || '';
    el.title = `Runs in: ${cwds[i]}`;
    fitPathLabel(el);
  });
}

// ---- rendering ----
// A hover-only "+" strip at an item boundary; clicking opens a chooser there.
// This is how anything gets added between two adjacent code blocks now that
// whitespace-only prose is dropped at parse time.
let pendingInsertIndex = null; // boundary whose chooser is open, if any

function makeInsertDivider(index) {
  const div = document.createElement('div');
  div.className = 'insert-divider';
  div.title = 'Insert here';
  div.innerHTML = '<span>+</span>';
  div.addEventListener('click', () => {
    pendingInsertIndex = index;
    renderNoteItems();
  });

  return div;
}

const ICON_TEXT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h16M4 11h16M4 16h10"/></svg>';
const ICON_CODE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/></svg>';
const ICON_CODE_SMALL = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/></svg>';

// Markdown source -> the plain text inside it. Converting prose to a runnable
// block should hand the shell the words, not the markup: a line like
// "- run `npm ci`" becomes "run npm ci".
function markdownToPlainText(md) {
  return (md || '')
    .split('\n')
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '') // heading marker
      .replace(/^\s{0,3}>\s?/, '') // blockquote
      .replace(/^\s*[-*+]\s+/, '') // bullet
      .replace(/^\s*\d+[.)]\s+/, '') // numbered item
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '') // horizontal rule
      .replace(/^\s*```.*$/, '')) // code fence markers
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // link -> label
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/~~([^~]+)~~/g, '$1') // strikethrough
    .trim();
}

// Replace a prose section with a code block holding its plain text. Opens the
// new block for editing so the shell dropdown is right there to adjust.
function convertProseToBlock(item) {
  const idx = currentItems.indexOf(item);
  if (idx === -1) return;
  currentItems.splice(idx, 1, {
    type: 'block',
    shell: defaultShell,
    code: markdownToPlainText(item.text),
    _justAdded: true,
  });
  renderNoteItems();
  markDirty();
  showToast('Converted to a code block');
}

// Two big targets shown at the boundary the user clicked: pick what to insert.
// It's transient UI state (not an item in currentItems), so cancelling leaves
// the note untouched — no empty placeholder to clean up afterwards.
function makeInsertChooser(index) {
  const wrap = document.createElement('div');
  wrap.className = 'insert-chooser';

  const makeBtn = (icon, label, hint, buildItem) => {
    const btn = document.createElement('button');
    btn.className = 'chooser-btn';
    btn.innerHTML = `${icon}<span class="chooser-label">${label}</span><span class="chooser-hint">${hint}</span>`;
    btn.addEventListener('click', () => {
      pendingInsertIndex = null;
      currentItems.splice(index, 0, buildItem());
      renderNoteItems(); // the new item carries _justAdded, so it opens focused
      markDirty();
    });
    return btn;
  };

  wrap.append(
    makeBtn(ICON_TEXT, 'Text', 'Markdown prose', () => ({ type: 'prose', text: '', _justAdded: true })),
    makeBtn(ICON_CODE, 'Code Block', 'Runnable shell', () => ({ type: 'block', shell: defaultShell, code: '', _justAdded: true })),
  );
  return wrap;
}

function cancelInsertChooser() {
  if (pendingInsertIndex === null) return;
  pendingInsertIndex = null;
  renderNoteItems();
}

// Dismiss on Escape or a click outside. Dividers are excluded so clicking a
// different one moves the chooser instead of just closing it.
document.addEventListener('mousedown', (e) => {
  if (pendingInsertIndex === null) return;
  if (e.target.closest('.insert-chooser, .insert-divider')) return;
  cancelInsertChooser();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelInsertChooser();
});

function renderNoteItems() {
  // Every block is rebuilt below, so drop the observers on the outgoing labels
  // rather than accumulating them on detached elements.
  pathLabelObserver.disconnect();
  noteItemsEl.innerHTML = '';
  if (!currentItems.length) {
    noteItemsEl.innerHTML = '<p class="empty">Empty note — add text or a code block.</p>';
    return;
  }
  let blockCounter = 0;
  currentItems.forEach((item, idx) => {
    noteItemsEl.appendChild(makeInsertDivider(idx));
    if (pendingInsertIndex === idx) noteItemsEl.appendChild(makeInsertChooser(idx));
    if (item.type === 'prose') {
      noteItemsEl.appendChild(renderProse(item));
    } else {
      item.index = blockCounter++;
      noteItemsEl.appendChild(renderBlock(item));
    }
  });
  noteItemsEl.appendChild(makeInsertDivider(currentItems.length));
  if (pendingInsertIndex === currentItems.length) noteItemsEl.appendChild(makeInsertChooser(currentItems.length));
  updateCwdLabels();
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

// Prose renders as part of a continuous document — no card, no header bar.
// Controls live in a slim gutter on the left that only appears on hover, so
// reading the note looks like reading a normal rendered .md file. Editing is
// deliberately NOT single-click (that would hijack text selection): use the
// gutter pencil or double-click. Empty prose items collapse to a thin spacer
// strip so the insertion point between two code blocks stays reachable.
function renderProse(item) {
  const wrap = document.createElement('div');
  wrap.className = 'prose';

  const gutter = document.createElement('div');
  gutter.className = 'item-gutter';
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  const editBtn = document.createElement('button');
  editBtn.className = 'gutter-btn';
  editBtn.textContent = '✎';
  editBtn.title = 'Edit text (or double-click it)';
  const convertBtn = document.createElement('button');
  convertBtn.className = 'gutter-btn';
  convertBtn.innerHTML = ICON_CODE_SMALL;
  convertBtn.title = 'Convert to a code block (Markdown formatting is dropped)';
  convertBtn.addEventListener('click', () => convertProseToBlock(item));
  const removeBtn = document.createElement('button');
  removeBtn.className = 'gutter-btn gutter-remove';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove this text';
  removeBtn.addEventListener('click', () => removeItem(item));
  gutter.append(handle, editBtn, convertBtn, removeBtn);
  attachDragHandlers(wrap, item, handle);

  const view = document.createElement('div');
  view.className = 'prose-view';

  const textarea = document.createElement('textarea');
  textarea.className = 'prose-edit hidden';
  textarea.addEventListener('input', () => { item.text = textarea.value; markDirty(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setEditing(false);
  });

  function renderView() {
    view.innerHTML = renderMarkdown(item.text);
  }

  function setEditing(on) {
    if (on) {
      textarea.value = item.text;
      textarea.rows = autoRows(item.text);
      view.classList.add('hidden');
      textarea.classList.remove('hidden');
      textarea.focus();
    } else {
      // A section left empty has no rendered form to return to — drop it
      // (it wouldn't survive a save anyway; the serializer skips empties).
      if (!item.text.trim() && currentItems.includes(item)) {
        currentItems = currentItems.filter((i) => i !== item);
        renderNoteItems();
        markDirty();
        return;
      }
      textarea.classList.add('hidden');
      view.classList.remove('hidden');
      renderView();
    }
  }

  editBtn.addEventListener('click', () => setEditing(true));
  view.addEventListener('dblclick', () => setEditing(true));
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) setEditing(false);
  });

  renderView();
  wrap.append(gutter, view, textarea);

  if (item._justAdded) {
    delete item._justAdded;
    setEditing(true);
    // focus() does nothing while the element is still detached, and our caller
    // appends this wrapper only after we return — so land the caret once the
    // whole render pass has finished.
    queueMicrotask(() => textarea.focus());
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
    updateCwdLabels(); // bare `cd` means home in bash but not in cmd/powershell
  });

  const runBtn = document.createElement('button');
  runBtn.className = 'run-btn';
  runBtn.innerHTML = '<span class="play-icon">&#9654;</span> Run';

  const cwdLabel = document.createElement('span');
  cwdLabel.className = 'cwd-label';
  pathLabelObserver.observe(cwdLabel);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn push-right';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => removeItem(block));

  header.append(handle, dot, shellLabel, shellSelect, runBtn, cwdLabel, removeBtn);
  attachDragHandlers(wrap, block, handle);

  const codeView = document.createElement('pre');
  codeView.className = 'code';
  const codeViewInner = document.createElement('code');
  codeView.appendChild(codeViewInner);

  const codeArea = document.createElement('textarea');
  codeArea.className = 'code-edit hidden';
  codeArea.addEventListener('input', () => {
    block.code = codeArea.value;
    markDirty();
    updateCwdLabels(); // typing a cd changes the folder of every block below
  });

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

  // Input row for the running process — visible only while status is running.
  // We can't detect "the process is waiting for input" without a PTY, so the
  // row is simply always available during a run.
  const stdinRow = document.createElement('div');
  stdinRow.className = 'stdin-row hidden';
  const stdinField = document.createElement('input');
  stdinField.type = 'text';
  stdinField.className = 'stdin-input';
  stdinField.placeholder = 'Send input to the running process… (Enter)';
  const stdinSendBtn = document.createElement('button');
  stdinSendBtn.className = 'toggle-btn stdin-send-btn';
  stdinSendBtn.textContent = 'Send';
  const stdinEofBtn = document.createElement('button');
  stdinEofBtn.className = 'toggle-btn';
  stdinEofBtn.textContent = 'End input';
  stdinEofBtn.title = 'Close stdin (like Ctrl+D) — for commands that read until end-of-input';
  stdinRow.append(stdinField, stdinSendBtn, stdinEofBtn);
  if (!ptyAvailable) {
    const hint = document.createElement('span');
    hint.className = 'stdin-hint';
    hint.textContent = 'basic input — see Help';
    hint.title = 'Line prompts work; TTY-only prompts (ssh, sudo) need node-pty. Click for details.';
    hint.addEventListener('click', () => document.getElementById('help-btn').click());
    stdinRow.appendChild(hint);
  }
  outputPanel.appendChild(stdinRow);

  async function sendStdin(eof) {
    if (!block.runningExecId) return;
    const payload = eof ? { eof: true } : { text: stdinField.value };
    const res = await fetch(`/api/executions/${block.runningExecId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) showToast((await res.json()).error || 'Failed to send input', 'error');
    else if (!eof) stdinField.value = '';
  }
  stdinSendBtn.addEventListener('click', () => sendStdin(false));
  stdinEofBtn.addEventListener('click', () => sendStdin(true));
  stdinField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendStdin(false);
  });

  renderCodeView();
  wrap.append(header, codeView, codeArea, outputPanel);

  if (block._justAdded) {
    delete block._justAdded;
    setEditing(true);
    queueMicrotask(() => codeArea.focus()); // see the note in renderProse
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
    // Exec buttons slot in before the cwd label, so the label reads as the
    // last piece of run info in the header: Run … Pop out · Kill · <folder>.
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.className = 'toggle-btn';
      toggleBtn.textContent = 'Show more';
      toggleBtn.addEventListener('click', () => {
        collapsed = !collapsed;
        toggleBtn.textContent = collapsed ? 'Show more' : 'Show less';
        renderOutput();
      });
      header.insertBefore(toggleBtn, cwdLabel);
    }
    if (!popoutBtn) {
      popoutBtn = document.createElement('button');
      popoutBtn.className = 'popout-btn';
      popoutBtn.textContent = 'Pop out';
      header.insertBefore(popoutBtn, cwdLabel);
    }
    if (!killBtn) {
      killBtn = document.createElement('button');
      killBtn.className = 'kill-btn';
      killBtn.textContent = 'Kill';
      header.insertBefore(killBtn, cwdLabel);
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
    fitPathLabel(cwdLabel); // these buttons just took space from the label
  }

  function attachToExecution(execId) {
    ensureExecButtons();
    stdinRow.classList.remove('hidden');
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
      stdinRow.classList.add('hidden');
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

    const res = await fetch('/api/blocks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shell: block.shell,
        code: block.code,
        noteFile: currentFile,
        noteTitle: currentFile,
        blockIndex: block.index,
        cwd: effectiveCwds()[block.index], // the folder shown on this block's label
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      // e.g. a cd above points at a folder that doesn't exist
      dot.className = 'status-dot failed';
      killBtn.classList.add('hidden');
      showToast(body.error || 'Failed to start block', 'error');
      return;
    }

    block.runningExecId = body.execId;
    attachToExecution(body.execId);
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
  currentItems.push({ type: 'block', shell: defaultShell, code: '', _justAdded: true });
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
      // A saved order refers to files by name, so a rename would otherwise
      // read as "old file gone, new file added" and send it to the end.
      const slot = noteList.findIndex((n) => n.file === original);
      if (slot !== -1 && !document.getElementById('sort-notes-btn').disabled) {
        noteList[slot] = { ...noteList[slot], file: newName };
        await saveNoteOrder();
      }
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

    const viewCell = tr.children[tr.children.length - 2];
    const actionCell = tr.lastElementChild;

    const viewBtn = document.createElement('button');
    viewBtn.className = 'popout-btn';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => window.open(`/output.html?execId=${ex.execId}`, '_blank', 'width=720,height=520'));
    viewCell.appendChild(viewBtn);

    if (ex.status === 'running') {
      const killBtn = document.createElement('button');
      killBtn.className = 'kill-btn';
      killBtn.textContent = 'Kill';
      killBtn.addEventListener('click', async () => {
        const res = await fetch(`/api/executions/${ex.execId}/kill`, { method: 'POST' });
        showToast(res.ok ? 'Process killed' : 'Failed to kill process', res.ok ? 'success' : 'error');
      });
      actionCell.appendChild(killBtn);
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
      actionCell.appendChild(removeBtn);
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

  document.querySelectorAll('#note-list .note-item').forEach((item) => {
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
