const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const { listNotes, parseNote, createNote, saveNote, deleteNote, renameNote } = require('./src/noteParser');
const { resolveShell, isWin } = require('./src/shellResolver');
const executor = require('./src/executor');
const configStore = require('./src/config');
const { browseForFolder } = require('./src/folderBrowser');
const logViewSettings = require('./src/logViewSettings');
const pkg = require('./package.json');

const PORT = process.env.PORT || 4488;
const HOST = '127.0.0.1'; // localhost only — this server executes arbitrary shell code
const SERVER_START_TIME = Date.now();
const STOCK_DEFAULT_NOTES_DIR = path.join(__dirname, 'notes');
const PUBLIC_DIR = path.join(__dirname, 'public');

function isUsableDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Two independent notions of "notes folder":
// - NOTES_DIR: the current working folder — set via the sidebar's Open button,
//   remembered, and reopened automatically next launch as long as it still exists.
// - DEFAULT_NOTES_DIR: the fallback folder used only the first time the app
//   runs, or if the remembered working folder is gone. Settings can reset the
//   current working folder back to this value, but not change it.
const savedConfig = configStore.load();
let DEFAULT_NOTES_DIR = isUsableDir(savedConfig.defaultNotesFolder) ? savedConfig.defaultNotesFolder : STOCK_DEFAULT_NOTES_DIR;
let NOTES_DIR = isUsableDir(savedConfig.notesFolder) ? savedConfig.notesFolder : DEFAULT_NOTES_DIR;

// Where code blocks run. Defaults to wherever the server was started from,
// changeable in Settings (persisted). Individual runs can further override it —
// the client sends the block's effective folder after simulating any `cd`
// commands in the blocks above it.
const DEFAULT_RUN_ROOT = process.cwd();
let RUN_ROOT = isUsableDir(savedConfig.runRoot) ? savedConfig.runRoot : DEFAULT_RUN_ROOT;

function starredForFolder() {
  return (configStore.load().starredNotes || {})[NOTES_DIR] || [];
}

function saveStarredForFolder(files) {
  const all = { ...(configStore.load().starredNotes || {}) };
  if (files.length) all[NOTES_DIR] = files;
  else delete all[NOTES_DIR]; // don't leave empty entries behind per folder
  configStore.update({ starredNotes: all });
}

// Reorders the (A–Z) note list to the arrangement saved for this folder.
// Files created since that arrangement was saved aren't in it — they keep
// their A–Z position relative to each other and land at the end, where they're
// easy to spot, rather than being dropped from the list.
function applyNoteOrder(notes) {
  const saved = (configStore.load().noteOrders || {})[NOTES_DIR];
  if (!Array.isArray(saved) || !saved.length) return notes;
  const remaining = new Map(notes.map((n) => [n.file, n]));
  const ordered = [];
  for (const file of saved) {
    if (remaining.has(file)) {
      ordered.push(remaining.get(file));
      remaining.delete(file);
    }
  }
  return [...ordered, ...remaining.values()];
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/meta' && req.method === 'GET') {
      return sendJson(res, 200, {
        version: pkg.version,
        license: pkg.license,
        author: pkg.author,
        serverStartTime: SERVER_START_TIME,
        notesFolder: NOTES_DIR,
        isDefaultFolder: NOTES_DIR === DEFAULT_NOTES_DIR,
        defaultNotesFolder: DEFAULT_NOTES_DIR,
        appDataDir: configStore.getAppDataDir(),
        isDefaultAppDataDir: configStore.isDefaultAppDataDir(),
        runRoot: RUN_ROOT,
        isDefaultRunRoot: RUN_ROOT === DEFAULT_RUN_ROOT,
        defaultRunRoot: DEFAULT_RUN_ROOT,
        homeDir: os.homedir(), // lets the client resolve `cd ~` in its cwd simulation
        ptyAvailable: executor.ptyAvailable, // full-terminal input vs basic pipe input
        defaultShell: isWin ? 'powershell' : 'bash', // what a new code block starts as
      });
    }

    if (p === '/api/run-root/browse' && req.method === 'POST') {
      const selected = await browseForFolder(RUN_ROOT);
      return sendJson(res, 200, { path: selected });
    }

    if (p === '/api/run-root' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!isUsableDir(body.path)) return sendJson(res, 400, { error: 'That folder does not exist.' });
      RUN_ROOT = path.resolve(body.path);
      configStore.update({ runRoot: RUN_ROOT });
      return sendJson(res, 200, { path: RUN_ROOT });
    }

    if (p === '/api/run-root/reset' && req.method === 'POST') {
      RUN_ROOT = DEFAULT_RUN_ROOT;
      configStore.update({ runRoot: undefined });
      return sendJson(res, 200, { path: RUN_ROOT });
    }

    if (p === '/api/app-data-folder/browse' && req.method === 'POST') {
      const selected = await browseForFolder(configStore.getAppDataDir());
      return sendJson(res, 200, { path: selected });
    }

    if (p === '/api/app-data-folder' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!isUsableDir(body.path)) return sendJson(res, 400, { error: 'That folder does not exist.' });
      configStore.setAppDataDir(body.path);
      return sendJson(res, 200, { path: configStore.getAppDataDir() });
    }

    if (p === '/api/app-data-folder/reset' && req.method === 'POST') {
      configStore.resetAppDataDir();
      return sendJson(res, 200, { path: configStore.getAppDataDir() });
    }

    if (p === '/api/app-data/clear' && req.method === 'POST') {
      configStore.clearAll(); // reset settings + pointer first, so history clears at the (now default) location
      executor.clearHistory();
      DEFAULT_NOTES_DIR = STOCK_DEFAULT_NOTES_DIR;
      NOTES_DIR = DEFAULT_NOTES_DIR;
      RUN_ROOT = DEFAULT_RUN_ROOT;
      return sendJson(res, 200, {
        notesFolder: NOTES_DIR,
        defaultNotesFolder: DEFAULT_NOTES_DIR,
        appDataDir: configStore.getAppDataDir(),
        runRoot: RUN_ROOT,
      });
    }

    // Highlight/bookmark settings for the pop-out log viewer. A run carries the
    // notes folder it belonged to, so a log opened long after a folder switch
    // still resolves against the right note-level settings rather than whatever
    // folder happens to be open now.
    function viewScope(url) {
      const execId = url.searchParams.get('execId') || undefined;
      const record = execId ? executor.get(execId) : null;
      return {
        execId,
        noteFile: url.searchParams.get('noteFile') || (record && record.noteFile) || undefined,
        notesFolder: (record && record.notesFolder) || NOTES_DIR,
      };
    }

    if (p === '/api/log-view-settings' && req.method === 'GET') {
      return sendJson(res, 200, logViewSettings.describe(viewScope(url)));
    }

    if (p === '/api/log-view-settings' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const scope = viewScope(url);
      logViewSettings.saveLevels({ ...scope, ...body, levels: body.levels });
      return sendJson(res, 200, logViewSettings.describe({ ...scope, ...body }));
    }

    if (p === '/api/log-view-settings/reset' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const scope = { ...viewScope(url), ...body };
      logViewSettings.resetLevel({ level: body.level, ...scope });
      return sendJson(res, 200, logViewSettings.describe(scope));
    }

    if (p === '/api/log-view-settings/theme' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return sendJson(res, 200, { theme: logViewSettings.setTheme(body.theme) });
    }

    const bookmarkMatch = p.match(/^\/api\/executions\/([^/]+)\/bookmarks$/);
    if (bookmarkMatch && req.method === 'GET') {
      return sendJson(res, 200, logViewSettings.getBookmarks(bookmarkMatch[1]));
    }

    if (bookmarkMatch && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      logViewSettings.saveBookmarks(bookmarkMatch[1], body.bookmarks || {});
      return sendJson(res, 200, { ok: true });
    }

    // Current working folder — set via the sidebar's Open button, remembered
    // and reopened automatically on the next launch as long as it still exists.
    if (p === '/api/notes-folder/browse' && req.method === 'POST') {
      const selected = await browseForFolder(NOTES_DIR);
      return sendJson(res, 200, { path: selected });
    }

    if (p === '/api/notes-folder' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!isUsableDir(body.path)) return sendJson(res, 400, { error: 'That folder does not exist.' });
      NOTES_DIR = path.resolve(body.path);
      configStore.update({ notesFolder: NOTES_DIR });
      return sendJson(res, 200, { path: NOTES_DIR });
    }

    if (p === '/api/notes' && req.method === 'GET') {
      // The stored starred list is itself the Quick access order, so its index
      // travels with each note and the client can lay both sections out from
      // one response.
      const starred = starredForFolder();
      const notes = applyNoteOrder(listNotes(NOTES_DIR))
        .map((n) => ({ ...n, starred: starred.includes(n.file), starIndex: starred.indexOf(n.file) }));
      return sendJson(res, 200, notes);
    }

    // Starred notes, stored per notes folder like the hand-arranged order.
    if (p === '/api/starred' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const next = starredForFolder().filter((f) => f !== body.file);
      if (body.starred) next.push(body.file); // newly starred notes go to the end
      saveStarredForFolder(next);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/starred/order' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const known = starredForFolder();
      const posted = (body.order || []).filter((f) => known.includes(f));
      // Reordering must never unstar: anything starred that the client didn't
      // list (it starred something in another tab, say) keeps its place at the
      // end instead of being dropped.
      const missing = known.filter((f) => !posted.includes(f));
      saveStarredForFolder([...posted, ...missing]);
      return sendJson(res, 200, { ok: true });
    }

    // A hand-arranged sidebar order, stored per notes folder so each folder
    // keeps its own arrangement across sessions and folder switches.
    if (p === '/api/notes-order' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const orders = { ...(configStore.load().noteOrders || {}) };
      orders[NOTES_DIR] = Array.isArray(body.order) ? body.order : [];
      configStore.update({ noteOrders: orders });
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/notes-order/reset' && req.method === 'POST') {
      const orders = { ...(configStore.load().noteOrders || {}) };
      delete orders[NOTES_DIR];
      configStore.update({ noteOrders: orders });
      // Sorting is a whole-sidebar action, so Quick access goes A–Z too.
      saveStarredForFolder([...starredForFolder()].sort((a, b) => a.localeCompare(b)));
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith('/api/notes/') && req.method === 'GET') {
      const file = decodeURIComponent(p.slice('/api/notes/'.length));
      if (!fs.existsSync(path.join(NOTES_DIR, file))) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, parseNote(NOTES_DIR, file));
    }

    if (p === '/api/notes' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const file = createNote(NOTES_DIR, body.file, body.content ?? '');
      return sendJson(res, 200, { file });
    }

    if (p.startsWith('/api/notes/') && req.method === 'PUT') {
      const file = decodeURIComponent(p.slice('/api/notes/'.length));
      const body = JSON.parse(await readBody(req));
      saveNote(NOTES_DIR, file, body.content ?? '');
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith('/api/notes/') && req.method === 'DELETE') {
      const file = decodeURIComponent(p.slice('/api/notes/'.length));
      deleteNote(NOTES_DIR, file);
      saveStarredForFolder(starredForFolder().filter((f) => f !== file));
      return sendJson(res, 200, { ok: true });
    }

    const renameMatch = p.match(/^\/api\/notes\/([^/]+)\/rename$/);
    if (renameMatch && req.method === 'POST') {
      const file = decodeURIComponent(renameMatch[1]);
      const body = JSON.parse(await readBody(req));
      const newFile = renameNote(NOTES_DIR, file, body.newName);
      // Starred state follows the file, rather than reading as "one note
      // vanished and an unrelated one appeared".
      const starred = starredForFolder();
      if (starred.includes(file)) saveStarredForFolder(starred.map((f) => (f === file ? newFile : f)));
      return sendJson(res, 200, { file: newFile });
    }

    if (p === '/api/blocks/run' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { shell, code, noteFile, noteTitle, blockIndex } = body;
      // The client sends the block's effective folder (run root threaded
      // through any `cd`s in earlier blocks). It's a simulation, so the folder
      // may not actually exist — refuse up front with a clear message rather
      // than letting spawn fail cryptically.
      const cwd = body.cwd || RUN_ROOT;
      if (!isUsableDir(cwd)) return sendJson(res, 400, { error: `Run folder does not exist: ${cwd}` });
      const { shellPath, buildArgs, verbatim } = resolveShell(shell);
      const execId = executor.createExecution({
        shellPath,
        args: buildArgs(code),
        cwd,
        noteFile,
        noteTitle,
        blockIndex,
        shellTag: shell,
        verbatim,
        notesFolder: NOTES_DIR,
      });
      return sendJson(res, 200, { execId });
    }

    if (p === '/api/executions' && req.method === 'GET') {
      return sendJson(res, 200, executor.list());
    }

    if (p === '/api/executions/clear' && req.method === 'POST') {
      executor.clearHistory();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/executions/kill-all' && req.method === 'POST') {
      const count = executor.killAll();
      return sendJson(res, 200, { count });
    }

    const execMatch = p.match(/^\/api\/executions\/([^/]+)$/);
    if (execMatch && req.method === 'GET') {
      const record = executor.get(execMatch[1]);
      return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: 'not found' });
    }

    if (execMatch && req.method === 'DELETE') {
      const ok = executor.remove(execMatch[1]);
      return sendJson(res, ok ? 200 : 404, { removed: ok });
    }

    const killMatch = p.match(/^\/api\/executions\/([^/]+)\/kill$/);
    if (killMatch && req.method === 'POST') {
      const ok = executor.kill(killMatch[1]);
      return sendJson(res, ok ? 200 : 404, { killed: ok });
    }

    const noteMatch = p.match(/^\/api\/executions\/([^/]+)\/note$/);
    if (noteMatch && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      // Single-line annotation — strip newlines and cap the length so a paste
      // can't turn the history index into a dumping ground.
      const note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const ok = executor.setNote(noteMatch[1], note);
      return ok ? sendJson(res, 200, { ok: true, note }) : sendJson(res, 404, { error: 'not found' });
    }

    const inputMatch = p.match(/^\/api\/executions\/([^/]+)\/input$/);
    if (inputMatch && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const ok = body.eof
        ? executor.closeInput(inputMatch[1])
        : executor.sendInput(inputMatch[1], String(body.text ?? ''));
      return ok
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 409, { error: 'Process is not running' });
    }

    const streamMatch = p.match(/^\/api\/executions\/([^/]+)\/stream$/);
    if (streamMatch && req.method === 'GET') {
      const execId = streamMatch[1];
      const record = executor.getRaw(execId);
      if (!record) return sendJson(res, 404, { error: 'not found' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ snapshot: record.output.join('') })}\n\n`);

      if (record.status !== 'running') {
        res.write(`event: done\ndata: ${JSON.stringify({ status: record.status, exitCode: record.exitCode })}\n\n`);
        return res.end();
      }

      const unsubscribe = executor.subscribe(execId, (chunk) => {
        if (chunk === null) {
          const final = executor.getRaw(execId);
          res.write(`event: done\ndata: ${JSON.stringify({ status: final.status, exitCode: final.exitCode })}\n\n`);
          res.end();
        } else {
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      });
      req.on('close', () => unsubscribe && unsubscribe());
      return;
    }

    return serveStatic(req, res, p);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`shellnote running at http://${HOST}:${PORT}`);
});
