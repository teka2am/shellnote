const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_FILENAME = 'settings.json';

// Where the app data folder lives per OS, following each platform's own convention.
function appDataDirFor(appName) {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, appName);
}

const DEFAULT_APP_DATA_DIR = appDataDirFor('shellnote');
// The app data folder itself can be relocated, which means it can't hold the
// pointer to its own location — that pointer has to live at a fixed spot the
// app can always find on startup, before any settings are loaded.
const POINTER_PATH = path.join(DEFAULT_APP_DATA_DIR, 'location.json');

// Settings lived next to the source code before app data folders existed —
// migrated into the resolved app data dir the first time it's read.
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', '.shellbook-config.json');

// The project (and app data folder) used to be named "shellbook" — copy that
// folder's contents over the first time the new "shellnote" dir is used, so
// existing settings/logs aren't orphaned by the rename.
function migrateLegacyAppDataDir() {
  const legacyDir = appDataDirFor('shellbook');
  if (fs.existsSync(DEFAULT_APP_DATA_DIR) || !fs.existsSync(legacyDir)) return;
  fs.mkdirSync(path.dirname(DEFAULT_APP_DATA_DIR), { recursive: true });
  fs.cpSync(legacyDir, DEFAULT_APP_DATA_DIR, { recursive: true });
}
migrateLegacyAppDataDir();

function readPointer() {
  try {
    const { appDataDir } = JSON.parse(fs.readFileSync(POINTER_PATH, 'utf8'));
    return appDataDir || null;
  } catch {
    return null;
  }
}

function getAppDataDir() {
  return readPointer() || DEFAULT_APP_DATA_DIR;
}

function isDefaultAppDataDir() {
  return getAppDataDir() === DEFAULT_APP_DATA_DIR;
}

function settingsPath() {
  return path.join(getAppDataDir(), SETTINGS_FILENAME);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8'));
      save(legacy);
      return legacy;
    } catch {
      return {};
    }
  }
}

function save(settings) {
  const dir = getAppDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SETTINGS_FILENAME), JSON.stringify(settings, null, 2), 'utf8');
}

// Merges a patch into existing settings instead of replacing the whole file —
// there are multiple independent keys now (current notes folder, default notes
// folder), so writing one must not clobber the other. A key set to `undefined`
// is dropped (JSON.stringify omits undefined values), which is how a single key
// gets reset without touching the rest.
function update(patch) {
  save({ ...load(), ...patch });
}

function setAppDataDir(newDir) {
  const resolved = path.resolve(newDir);
  const oldDir = getAppDataDir(); // capture before the pointer changes
  fs.mkdirSync(DEFAULT_APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(POINTER_PATH, JSON.stringify({ appDataDir: resolved }, null, 2), 'utf8');

  // Move everything that was living at the old location (settings, logs, etc.)
  // over to the new one — the app data folder holds more than just settings now,
  // and relocating it should relocate all of it, not just the file this module owns.
  if (path.resolve(oldDir) === resolved || !fs.existsSync(oldDir)) return;
  fs.mkdirSync(resolved, { recursive: true });
  for (const entry of fs.readdirSync(oldDir)) {
    if (entry === 'location.json') continue; // the pointer file itself never moves
    const from = path.join(oldDir, entry);
    const to = path.join(resolved, entry);
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function resetAppDataDir() {
  try {
    fs.unlinkSync(POINTER_PATH);
  } catch {
    // already at the default location
  }
}

function clearAll() {
  resetAppDataDir();
  save({});
}

module.exports = {
  load,
  save,
  update,
  getAppDataDir,
  getDefaultAppDataDir: () => DEFAULT_APP_DATA_DIR,
  isDefaultAppDataDir,
  setAppDataDir,
  resetAppDataDir,
  clearAll,
};
