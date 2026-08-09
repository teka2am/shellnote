const fs = require('fs');
const path = require('path');
const configStore = require('./config');

// Highlight/bookmark settings for the pop-out log viewer.
//
// Three levels, each inheriting from the one above it:
//   global      → settings.json, applies everywhere
//   note file   → settings.json, keyed by notes folder + file
//   log         → a sidecar file next to that run's .log, so it travels and
//                 dies with the run it belongs to
//
// A rule lives at exactly one level. Resolving walks global → note → log and
// lets the deepest definition of an id win, so "which level is this rule from"
// is always answerable — that's the scope tag the settings UI shows.

// Colours are named, never stored as hex: a theme maps the name to an actual
// value, so switching themes restyles existing rules instead of stranding them
// on colours from the old palette.
const HUES = {
  red: { hue: 0, sat: 1 },
  orange: { hue: 26, sat: 1 },
  yellow: { hue: 46, sat: 1 },
  green: { hue: 140, sat: 0.95 },
  teal: { hue: 174, sat: 0.95 },
  blue: { hue: 210, sat: 1 },
  purple: { hue: 268, sat: 1 },
  pink: { hue: 328, sat: 1 },
  grey: { hue: 220, sat: 0.12 },
};

// Highlights are a background wash only — the log's own text colour is never
// touched, so nothing the process actually printed is misrepresented. Bookmarks
// sit above them at full strength, because they're navigation markers the user
// placed by hand and needs to pick out at a glance.
const THEMES = {
  friendly: {
    label: 'Friendly',
    hint: 'Soft pastel washes — easy to sit in front of for a long run.',
    highlight: { s: 68, l: 58, a: 0.22 },
    bookmark: { s: 62, l: 56, a: 0.95 },
  },
  contrast: {
    label: 'High contrast',
    hint: 'Stronger, more saturated fills — easier to pick out at a glance.',
    highlight: { s: 92, l: 52, a: 0.42 },
    bookmark: { s: 96, l: 48, a: 1 },
  },
};

const DEFAULT_THEME = 'friendly';

// The five bookmark colours, in the order the picker offers them.
const BOOKMARK_COLORS = ['red', 'orange', 'green', 'blue', 'purple'];

function colorValue(name, theme, kind) {
  const hue = HUES[name] || HUES.grey;
  const t = (THEMES[theme] || THEMES[DEFAULT_THEME])[kind];
  return `hsl(${hue.hue} ${Math.round(t.s * hue.sat)}% ${t.l}% / ${t.a})`;
}

// Seeded from the level words the viewer used to infer, but as plain keyword
// lists the user can see and edit — the old inference was invisible and only
// ever right for logs that happened to follow the same conventions.
const DEFAULT_RULES = [
  {
    id: 'error',
    label: 'Error',
    color: 'red',
    keywords: ['error', 'errors', 'err', 'failed', 'failure', 'fail', 'fatal', 'critical', 'panic', 'exception', 'traceback', 'denied', 'refused', 'timeout', 'unable'],
  },
  {
    id: 'warning',
    label: 'Warning',
    color: 'orange',
    keywords: ['warn', 'warning', 'warnings', 'deprecated', 'deprecation', 'caution', 'skipped', 'retry', 'retrying'],
  },
  {
    id: 'success',
    label: 'Success',
    color: 'green',
    keywords: ['success', 'successful', 'successfully', 'succeeded', 'passed', 'pass', 'ok', 'done', 'complete', 'completed', 'ready', 'created'],
  },
  {
    id: 'debug',
    label: 'Debug',
    color: 'blue',
    keywords: ['debug', 'trace', 'verbose'],
  },
  {
    id: 'info',
    label: 'Info',
    color: 'grey',
    keywords: ['info', 'notice'],
  },
];

function defaultRules() {
  return DEFAULT_RULES.map((r) => ({ ...r, keywords: [...r.keywords], enabled: true, wholeWord: true, matchCase: false }));
}

function defaultLevel() {
  return { rules: {}, order: null };
}

// ---- per-level storage ----

function globalLevel() {
  const stored = configStore.load().logView;
  return { ...defaultLevel(), ...(stored || {}) };
}

function saveGlobalLevel(level) {
  const existing = configStore.load().logView || {};
  configStore.update({ logView: { ...existing, ...level } });
}

function getTheme() {
  const theme = (configStore.load().logView || {}).theme;
  return THEMES[theme] ? theme : DEFAULT_THEME;
}

function setTheme(theme) {
  if (!THEMES[theme]) return getTheme();
  saveGlobalLevel({ theme });
  return theme;
}

function noteLevel(notesFolder, noteFile) {
  if (!notesFolder || !noteFile) return defaultLevel();
  const all = configStore.load().noteLogView || {};
  return { ...defaultLevel(), ...(((all[notesFolder] || {})[noteFile]) || {}) };
}

function saveNoteLevel(notesFolder, noteFile, level) {
  if (!notesFolder || !noteFile) return;
  const all = { ...(configStore.load().noteLogView || {}) };
  const forFolder = { ...(all[notesFolder] || {}) };
  if (isEmptyLevel(level)) delete forFolder[noteFile];
  else forFolder[noteFile] = level;
  if (Object.keys(forFolder).length) all[notesFolder] = forFolder;
  else delete all[notesFolder]; // don't leave empty folder entries behind
  configStore.update({ noteLogView: all });
}

function isEmptyLevel(level) {
  return !level || (!level.order && !Object.keys(level.rules || {}).length);
}

// The per-run sidecar holds both the log's own rule overrides and its
// bookmarks, so one file appears and disappears with the run.
function sidecarPath(execId) {
  return path.join(configStore.getAppDataDir(), 'logs', `${execId}.view.json`);
}

function readSidecar(execId) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(execId), 'utf8'));
  } catch {
    return {};
  }
}

function writeSidecar(execId, data) {
  try {
    fs.mkdirSync(path.dirname(sidecarPath(execId)), { recursive: true });
    fs.writeFileSync(sidecarPath(execId), JSON.stringify(data), 'utf8');
  } catch {
    // Best-effort, like the run log itself — losing bookmarks must never break a run.
  }
}

function deleteSidecar(execId) {
  try {
    fs.unlinkSync(sidecarPath(execId));
  } catch {
    // never written, or already gone
  }
}

function logLevel(execId) {
  if (!execId) return defaultLevel();
  const { rules, order } = readSidecar(execId);
  return { ...defaultLevel(), ...(rules ? { rules } : {}), ...(order ? { order } : {}) };
}

function saveLogLevel(execId, level) {
  if (!execId) return;
  const sidecar = readSidecar(execId);
  if (isEmptyLevel(level)) {
    delete sidecar.rules;
    delete sidecar.order;
  } else {
    sidecar.rules = level.rules || {};
    sidecar.order = level.order || null;
  }
  writeSidecar(execId, sidecar);
}

function getBookmarks(execId) {
  const { bookmarks } = readSidecar(execId);
  return bookmarks && typeof bookmarks === 'object' ? bookmarks : {};
}

function saveBookmarks(execId, bookmarks) {
  const sidecar = readSidecar(execId);
  sidecar.bookmarks = bookmarks || {};
  writeSidecar(execId, sidecar);
}

// ---- resolution ----

// Walks the three levels in order and records, for each rule id, both the
// winning definition and the level it came from. A level can also carry a
// tombstone (`deleted: true`) so a default rule can be removed further down
// without the default reappearing on the next resolve.
function resolve({ notesFolder, noteFile, execId } = {}) {
  const levels = [
    ['default', { rules: Object.fromEntries(defaultRules().map((r) => [r.id, r])), order: DEFAULT_RULES.map((r) => r.id) }],
    ['global', globalLevel()],
    ['note', noteLevel(notesFolder, noteFile)],
    ['log', logLevel(execId)],
  ];

  const merged = new Map(); // id -> { rule, scope }
  let order = null;
  for (const [scope, level] of levels) {
    for (const [id, rule] of Object.entries(level.rules || {})) {
      if (rule && rule.deleted) merged.delete(id);
      else merged.set(id, { rule: { ...(merged.get(id) || {}).rule, ...rule, id }, scope });
    }
    if (level.order) order = level.order;
  }

  const ids = [...merged.keys()];
  const ordered = order ? [...order.filter((id) => merged.has(id)), ...ids.filter((id) => !order.includes(id))] : ids;

  const theme = getTheme();
  return {
    theme,
    rules: ordered.map((id) => {
      const { rule, scope } = merged.get(id);
      return { ...rule, scope, colorValue: colorValue(rule.color, theme, 'highlight') };
    }),
  };
}

// Everything the settings UI needs in one response: what each level stores on
// its own (so a field can show and change its scope), the resolved result, and
// the palettes to pick from.
function describe({ notesFolder, noteFile, execId } = {}) {
  return {
    theme: getTheme(),
    themes: Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, hint: t.hint })),
    palette: Object.keys(HUES).map((name) => ({
      name,
      highlight: colorValue(name, getTheme(), 'highlight'),
      bookmark: colorValue(name, getTheme(), 'bookmark'),
    })),
    bookmarkColors: BOOKMARK_COLORS.map((name) => ({ name, value: colorValue(name, getTheme(), 'bookmark') })),
    defaults: defaultRules(),
    levels: {
      global: globalLevel(),
      note: noteLevel(notesFolder, noteFile),
      log: logLevel(execId),
    },
    resolved: resolve({ notesFolder, noteFile, execId }).rules,
  };
}

function saveLevels({ notesFolder, noteFile, execId, levels }) {
  if (!levels) return;
  if (levels.global) saveGlobalLevel({ rules: levels.global.rules || {}, order: levels.global.order || null });
  if (levels.note) saveNoteLevel(notesFolder, noteFile, { rules: levels.note.rules || {}, order: levels.note.order || null });
  if (levels.log) saveLogLevel(execId, levels.log);
}

function resetLevel({ level, notesFolder, noteFile, execId }) {
  if (level === 'global') saveGlobalLevel({ rules: {}, order: null });
  else if (level === 'note') saveNoteLevel(notesFolder, noteFile, defaultLevel());
  else if (level === 'log') saveLogLevel(execId, defaultLevel());
}

module.exports = {
  describe,
  resolve,
  saveLevels,
  resetLevel,
  getTheme,
  setTheme,
  getBookmarks,
  saveBookmarks,
  deleteSidecar,
  defaultRules,
  BOOKMARK_COLORS,
};
