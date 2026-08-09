const fs = require('fs');
const path = require('path');

const SUPPORTED_TAGS = new Set(['powershell', 'cmd', 'bash', 'gitbash']);

function walkNotes(notesDir, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // skip dotfolders like .git if the chosen root happens to be a repo
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkNotes(notesDir, abs, out);
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      const rel = path.relative(notesDir, abs).split(path.sep).join('/');
      out.push({ file: rel, path: abs });
    }
  }
}

function listNotes(notesDir) {
  const out = [];
  walkNotes(notesDir, notesDir, out);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

function parseNote(notesDir, file) {
  const { resolved: filePath } = safeRelativePath(notesDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : file;

  const items = [];
  let proseBuffer = [];
  let blockIndex = 0;
  let i = 0;

  // Whitespace-only runs (e.g. the blank line separating two adjacent fences)
  // are not content — emitting them as prose items would litter the UI with
  // empty text sections on every load or raw/view toggle.
  const flushProse = () => {
    if (proseBuffer.length && proseBuffer.join('\n').trim()) {
      items.push({ type: 'prose', text: proseBuffer.join('\n') });
    }
    proseBuffer = [];
  };

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```(\w+)\s*$/);
    if (fenceMatch && SUPPORTED_TAGS.has(fenceMatch[1])) {
      flushProse();
      const shell = fenceMatch[1];
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      items.push({ type: 'block', index: blockIndex++, shell, code: codeLines.join('\n') });
      i++; // skip closing fence
      continue;
    }
    proseBuffer.push(lines[i]);
    i++;
  }
  flushProse();

  return { file, title, items };
}

// Notes can live in subfolders under the root, so we can't just reject paths
// containing separators (like the old basename-only check did) — instead resolve
// against the root and verify the result is still contained within it, which is
// what actually prevents escaping the notes folder via "../" segments.
function safeRelativePath(notesDir, file) {
  const normalized = String(file || '').split(/[\\/]+/).join('/');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('invalid note path');
  }
  if (!normalized.toLowerCase().endsWith('.md')) {
    throw new Error('note filename must end with .md');
  }
  const root = path.resolve(notesDir);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('invalid note path');
  }
  return { normalized, resolved };
}

function createNote(notesDir, file, content) {
  const { normalized, resolved } = safeRelativePath(notesDir, file);
  if (fs.existsSync(resolved)) throw new Error(`"${normalized}" already exists`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return normalized;
}

function saveNote(notesDir, file, content) {
  const { normalized, resolved } = safeRelativePath(notesDir, file);
  if (!fs.existsSync(resolved)) throw new Error(`"${normalized}" not found`);
  fs.writeFileSync(resolved, content, 'utf8');
}

function deleteNote(notesDir, file) {
  const { normalized, resolved } = safeRelativePath(notesDir, file);
  if (!fs.existsSync(resolved)) throw new Error(`"${normalized}" not found`);
  fs.unlinkSync(resolved);
}

function renameNote(notesDir, file, newName) {
  const from = safeRelativePath(notesDir, file);
  const to = safeRelativePath(notesDir, newName);
  if (!fs.existsSync(from.resolved)) throw new Error(`"${from.normalized}" not found`);
  if (fs.existsSync(to.resolved)) throw new Error(`"${to.normalized}" already exists`);
  fs.mkdirSync(path.dirname(to.resolved), { recursive: true });
  fs.renameSync(from.resolved, to.resolved);
  return to.normalized;
}

module.exports = { listNotes, parseNote, createNote, saveNote, deleteNote, renameNote };
