document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') === 'light' ? 'light' : 'dark');

const params = new URLSearchParams(location.search);
const execId = params.get('execId');
const $ = (id) => document.getElementById(id);

const dot = $('out-dot');
const meta = $('out-meta');
const scroller = $('out-full');
const linesEl = $('out-lines');
const killBtn = $('out-kill');
const stdinRow = $('out-stdin');
const stdinField = $('out-stdin-input');
const searchField = $('out-search');
const matchLabel = $('out-matches');
const jumpBtn = $('out-jump');
const lineCountEl = $('out-linecount');
const filterInfoEl = $('out-filterinfo');
const minimap = $('out-minimap');
const minimapCanvas = $('out-minimap-canvas');
const minimapMarks = $('out-minimap-marks');
const viewportBox = $('out-viewport');
const bmWidget = $('out-bm');
const bmColorsEl = $('out-bm-colors');

// The still-unterminated last line lives in its own row outside #out-lines, so
// rebuilding the committed rows never has to special-case it.
const tailEl = document.createElement('div');
tailEl.className = 'log-line hidden';
scroller.appendChild(tailEl);

// ---- log model ----
// Output is kept as parsed lines rather than one blob: every feature here
// (highlights, bookmarks, filtering, the overview ruler) is per-line, and rows
// can then be appended as they arrive instead of the whole view being rewritten
// seven times a second while a chatty process streams.
const MAX_OUTPUT_CHARS = 1_000_000;
const TRIM_TARGET_CHARS = MAX_OUTPUT_CHARS * 0.8;

let committed = []; // { text, hl }
let tail = '';
let tailHl = null;
let firstLineNo = 1; // absolute number of committed[0]; survives trimming
let totalChars = 0;

let rules = []; // compiled highlight rules, in the order the settings list shows
let matchOrder = []; // the same rules, most specific scope first
let bookmarkColors = []; // { name, value }
let bookmarks = new Map(); // absolute line number -> { color, comment }
let counts = new Map(); // rule id -> matching line count

// A line gets one highlight, so something has to win when two rules match it.
// Scope decides: a rule written for this one run beats a note-wide rule, which
// beats a global one. Without this the broad seeded rules ("info", "error")
// would swallow every line and a narrower rule added for one log could never
// show up — which is exactly what the levels used to get wrong.
const SCOPE_RANK = { log: 0, note: 1, global: 2, default: 3 };

function setRules(resolved) {
  rules = window.HighlightEditor.compile(resolved);
  matchOrder = [...rules].sort((a, b) => (SCOPE_RANK[a.scope] ?? 3) - (SCOPE_RANK[b.scope] ?? 3));
}

function matchHighlight(text) {
  for (const rule of matchOrder) if (rule.re.test(text)) return rule.id;
  return null;
}

function recount() {
  counts = new Map();
  for (const line of committed) if (line.hl) counts.set(line.hl, (counts.get(line.hl) || 0) + 1);
  if (tailHl) counts.set(tailHl, (counts.get(tailHl) || 0) + 1);
}

function resetModel() {
  committed = [];
  tail = '';
  tailHl = null;
  firstLineNo = 1;
  totalChars = 0;
  needsFullRender = true;
  resetBlocks();
}

function ingest(text) {
  const parts = (tail + text).split('\n');
  tail = parts.pop();
  for (const part of parts) {
    const clean = part.endsWith('\r') ? part.slice(0, -1) : part; // CRLF from Windows shells
    const hl = matchHighlight(clean);
    committed.push({ text: clean, hl });
    if (hl) counts.set(hl, (counts.get(hl) || 0) + 1);
    totalChars += clean.length + 1;
  }
  tailHl = tail ? matchHighlight(tail) : null;
  trimIfNeeded();
  scheduleDetect();
}

// Mirrors the server's own cap on retained output. Dropping from the front
// invalidates every rendered row's position, so this asks for a full rebuild —
// it happens once per ~200K characters, not per line.
function trimIfNeeded() {
  if (totalChars <= MAX_OUTPUT_CHARS) return;
  while (totalChars > TRIM_TARGET_CHARS && committed.length > 1) {
    const line = committed.shift();
    totalChars -= line.text.length + 1;
    if (line.hl) counts.set(line.hl, (counts.get(line.hl) || 0) - 1);
    firstLineNo++;
  }
  needsFullRender = true;
  // Every detected block's position was measured against the old front of the
  // buffer, and a block may have been cut in half by the trim. Cheaper to find
  // them all again — like the rebuild above, this is a once-per-200K-chars cost.
  resetBlocks();
}

// ---- view state ----
const hiddenHighlights = new Set();
const hiddenBookmarks = new Set();
let showOthers = true; // lines that are neither highlighted nor bookmarked
let search = '';
let useRegex = false;
let caseSensitive = false;
let onlyMatches = false;
let matcher = null; // RegExp, or 'invalid' while the typed regex doesn't compile
let matchEls = [];
let matchIndex = -1;
let following = true;
let needsFullRender = true;
let renderedCount = 0;
let markup = false; // decided once settings arrive — see initMarkupToggle()

function buildMatcher() {
  if (!search) return null;
  const source = useRegex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    return 'invalid';
  }
}

const hasMatcher = () => matcher && matcher !== 'invalid';

function testMatch(text) {
  matcher.lastIndex = 0;
  return matcher.test(text);
}

function isVisible(text, hl, lineNo) {
  const bm = bookmarks.get(lineNo);
  if (hl && hiddenHighlights.has(hl)) return false;
  if (bm && hiddenBookmarks.has(bm.color)) return false;
  if (!hl && !bm && !showOthers) return false;
  if (onlyMatches && hasMatcher()) return testMatch(text);
  return true;
}

// Writes the line's text into a row, wrapping search hits in <mark> so they can
// be highlighted and stepped through, and the active data block's slice of the
// line in a <span> so it can be shaded. Without either it's a single text node,
// much cheaper for the thousands of rows a long run produces.
//
// The two overlap freely — a search hit can start outside the block and end
// inside it — so rather than nesting one inside the other, the line is cut at
// every boundary and each piece is emitted with whatever it happens to be in.
function paint(el, text, range) {
  if (!hasMatcher() && !range) {
    el.textContent = text;
    return;
  }

  const marks = [];
  if (hasMatcher()) {
    matcher.lastIndex = 0;
    let m;
    while ((m = matcher.exec(text))) {
      if (m[0].length === 0) { matcher.lastIndex++; continue; } // `a*` matches empty forever otherwise
      marks.push([m.index, m.index + m[0].length]);
    }
  }
  if (!marks.length && !range) {
    el.textContent = text;
    return;
  }

  const cuts = new Set([0, text.length]);
  if (range) { cuts.add(range.from); cuts.add(range.to); }
  for (const [a, b] of marks) { cuts.add(a); cuts.add(b); }
  const points = [...cuts].sort((a, b) => a - b);

  const frag = document.createDocumentFragment();
  let mi = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    while (mi < marks.length && marks[mi][1] <= from) mi++;
    const isMark = mi < marks.length && marks[mi][0] <= from;
    let node;
    if (isMark) {
      node = document.createElement('mark');
      node.textContent = text.slice(from, to);
    } else {
      node = document.createTextNode(text.slice(from, to));
    }
    if (range && from >= range.from && to <= range.to) {
      const span = document.createElement('span');
      // The ends are rounded only where the block itself begins and ends, so a
      // block running over ten lines reads as one shape rather than ten pills.
      span.className = `dblk${range.head && from === range.from ? ' dblk-a' : ''}${range.tail && to === range.to ? ' dblk-z' : ''}`;
      span.appendChild(node);
      node = span;
    }
    frag.appendChild(node);
  }
  el.replaceChildren(frag);
}

function colorOfRule(id) {
  const rule = rules.find((r) => r.id === id);
  return rule ? rule.colorValue : null;
}

function bookmarkColor(name) {
  const c = bookmarkColors.find((b) => b.name === name);
  return c ? c.value : null;
}

// Markup governs the highlight background and nothing else: with it off the
// text reads exactly as the process emitted it, while the bookmark flag on the
// left and the ruler on the right stay put — they're navigation the reader
// placed, not decoration on the log's own content.
function decorate(el, hl, lineNo) {
  const bm = bookmarks.get(lineNo);
  el.style.backgroundImage = '';
  el.removeAttribute('title');
  const oldFlag = el.querySelector(':scope > .bm-flag');
  if (oldFlag) oldFlag.remove();

  if (markup) {
    const color = hl && colorOfRule(hl);
    if (color) el.style.backgroundImage = `linear-gradient(${color}, ${color})`;
  }

  if (!bm) {
    delete el.dataset.bm;
    return;
  }
  el.dataset.bm = bm.color;
  // A bookmark shows as the bookmark icon itself, in its colour — not a bar
  // down the edge, which reads as just another kind of highlight.
  el.appendChild(bookmarkFlag(bm.color));
  // The comment shows as the row's tooltip and on the ruler mark. It used to
  // also put a dot at the row's right edge, but that sat beside the ruler
  // without lining up with the bookmark's mark on it, which read as a second,
  // unrelated marker.
  if (bm.comment) el.title = bm.comment;
}

const FLAG_PATH = 'M4 2.5h8a.5.5 0 0 1 .5.5v10.2a.4.4 0 0 1-.62.34L8 11.1l-3.88 2.44a.4.4 0 0 1-.62-.34V3a.5.5 0 0 1 .5-.5Z';

function bookmarkFlag(colorName) {
  const span = document.createElement('span');
  span.className = 'bm-flag';
  span.style.color = bookmarkColor(colorName) || 'currentColor';
  span.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="${FLAG_PATH}" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
  return span;
}

function buildRow(line, lineNo) {
  const el = document.createElement('div');
  el.className = 'log-line';
  el.dataset.n = lineNo;
  paint(el, line.text, blockRangeIn(lineNo, line.text.length));
  decorate(el, line.hl, lineNo);
  return el;
}

function render() {
  if (needsFullRender) {
    linesEl.replaceChildren();
    renderedCount = 0;
    needsFullRender = false;
  }

  const frag = document.createDocumentFragment();
  for (let i = renderedCount; i < committed.length; i++) {
    const line = committed[i];
    const lineNo = firstLineNo + i;
    if (isVisible(line.text, line.hl, lineNo)) frag.appendChild(buildRow(line, lineNo));
  }
  renderedCount = committed.length;
  if (frag.childNodes.length) linesEl.appendChild(frag);

  renderTail();
  refreshMatches();
  updateStatus();
  scheduleMinimap();
  // A rebuild replaced the rows the active block was painted into.
  if (activeBlock) {
    refreshBlockAnchors();
    positionDataChip();
  }
  if (following) scroller.scrollTop = scroller.scrollHeight;
}

function renderTail() {
  const lineNo = firstLineNo + committed.length;
  if (!tail) {
    tailEl.className = 'log-line hidden';
    return;
  }
  tailEl.className = `log-line${isVisible(tail, tailHl, lineNo) ? '' : ' hidden'}`;
  tailEl.dataset.n = lineNo;
  paint(tailEl, tail, blockRangeIn(lineNo, tail.length));
  decorate(tailEl, tailHl, lineNo);
}

let renderScheduled = false;
// setTimeout, not requestAnimationFrame — RAF is fully paused by browsers for
// background/inactive windows, which is exactly the common case for this pop-out
// (user switches back to the main tab while a long job keeps running here).
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    render();
  }, 150);
}

function rerenderAll() {
  needsFullRender = true;
  render();
}

// ---- match navigation ----
function refreshMatches() {
  if (!hasMatcher()) {
    matchEls = [];
    matchIndex = -1;
    matchLabel.textContent = '0/0';
    return;
  }
  matchEls = [...scroller.querySelectorAll('mark')];
  if (matchIndex >= matchEls.length) matchIndex = matchEls.length - 1;
  if (matchIndex >= 0) matchEls[matchIndex].classList.add('is-current'); // class was lost with the old node
  updateMatchLabel();
}

function updateMatchLabel() {
  matchLabel.textContent = matcher === 'invalid' ? 'bad regex' : `${matchIndex + 1}/${matchEls.length}`;
}

function gotoMatch(delta) {
  if (!matchEls.length) return;
  if (matchIndex >= 0) matchEls[matchIndex].classList.remove('is-current');
  matchIndex = (matchIndex + delta + matchEls.length) % matchEls.length;
  const el = matchEls[matchIndex];
  el.classList.add('is-current');
  // Stepping through matches means reading, not tailing — release the follow
  // lock so the next chunk of output doesn't yank the view back to the bottom.
  following = false;
  el.scrollIntoView({ block: 'center' });
  updateJumpButton();
  updateMatchLabel();
}

// ---- status ----
function updateStatus() {
  const total = committed.length + (tail ? 1 : 0);
  const shown = linesEl.childElementCount + (tail && !tailEl.classList.contains('hidden') ? 1 : 0);
  lineCountEl.textContent = `${total.toLocaleString()} line${total === 1 ? '' : 's'}`;
  filterInfoEl.textContent = shown === total ? '' : `showing ${shown.toLocaleString()}`;
  // Says out loud that detection ran and what it found — otherwise the feature
  // is invisible until you happen to hover the right part of the right line.
  dataCountEl.textContent = dataOn && blocks.length
    ? `${blocks.length.toLocaleString()} data block${blocks.length === 1 ? '' : 's'}`
    : '';
  renderPanel();
}

function applyFilterChange() {
  matcher = buildMatcher();
  searchField.classList.toggle('invalid', matcher === 'invalid');
  matchIndex = -1;
  rerenderAll();
}

// ---- overview ruler (right-hand scrollbar) ----
// Highlight bars go on a canvas — at 20k lines a div per mark would be tens of
// thousands of nodes. Bookmarks stay as DOM elements: there are few of them and
// they must keep a constant size when the ruler expands.
let minimapScheduled = false;
function scheduleMinimap() {
  if (minimapScheduled) return;
  minimapScheduled = true;
  setTimeout(() => {
    minimapScheduled = false;
    drawMinimap();
  }, 200);
}

function visibleLineList() {
  const out = [];
  for (let i = 0; i < committed.length; i++) {
    const line = committed[i];
    const lineNo = firstLineNo + i;
    if (isVisible(line.text, line.hl, lineNo)) out.push({ lineNo, hl: line.hl, bm: bookmarks.get(lineNo) });
  }
  const tailNo = firstLineNo + committed.length;
  if (tail && isVisible(tail, tailHl, tailNo)) out.push({ lineNo: tailNo, hl: tailHl, bm: bookmarks.get(tailNo) });
  return out;
}

function drawMinimap() {
  const rect = minimap.getBoundingClientRect();
  const h = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  // Backing store is sized for the expanded width, so hovering doesn't force a
  // redraw and the bars simply stretch.
  const w = 44;
  if (minimapCanvas.width !== w * dpr || minimapCanvas.height !== h * dpr) {
    minimapCanvas.width = w * dpr;
    minimapCanvas.height = h * dpr;
  }
  const ctx = minimapCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const lines = visibleLineList();
  const n = lines.length || 1;
  const barH = Math.max(2, h / n);

  for (let i = 0; i < lines.length; i++) {
    const color = lines[i].hl && colorOfRule(lines[i].hl);
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(0, (i / n) * h, w, barH);
  }

  drawDataMarks(ctx, lines, n, h, w, barH);

  minimapMarks.replaceChildren(...lines.flatMap((line, i) => {
    if (!line.bm) return [];
    const mark = document.createElement('span');
    mark.className = 'bm-mark';
    mark.style.top = `${(i / n) * h}px`;
    mark.style.background = bookmarkColor(line.bm.color) || 'currentColor';
    mark.title = line.bm.comment
      ? `Line ${line.lineNo.toLocaleString()}: ${line.bm.comment}`
      : `Bookmark on line ${line.lineNo.toLocaleString()}`;
    mark.onclick = (e) => {
      e.stopPropagation();
      scrollToFraction(i / n);
    };
    return [mark];
  }));

  updateViewportBox();
}

// Data blocks get a rail down the ruler's left edge rather than a full-width
// bar: a highlight is a property of the line, but a data block is a region
// spanning many of them, and a rail reads as one continuous run. It sits on
// the near edge so it never hides the highlight colours behind it, and the
// block you're pointing at thickens so you can see where you are in a long log.
function drawDataMarks(ctx, lines, n, h, w, barH) {
  if (!dataOn || (!blocks.length && !activeBlock)) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--data-mark').trim() || '#5ec8d8';
  ctx.fillStyle = color;
  let bi = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = lines[i].lineNo;
    while (bi < blocks.length && blocks[bi].el < lineNo) bi++;
    const b = blocks[bi];
    const covered = (b && lineNo >= b.sl && lineNo <= b.el)
      || (activeBlock && lineNo >= activeBlock.sl && lineNo <= activeBlock.el);
    if (!covered) continue;
    const live = activeBlock && lineNo >= activeBlock.sl && lineNo <= activeBlock.el;
    ctx.globalAlpha = live ? 1 : 0.75;
    ctx.fillRect(0, (i / n) * h, w * (live ? 0.45 : 0.2), barH);
  }
  ctx.globalAlpha = 1;
}

function updateViewportBox() {
  const total = scroller.scrollHeight || 1;
  const frac = scroller.clientHeight / total;
  viewportBox.style.top = `${(scroller.scrollTop / total) * 100}%`;
  viewportBox.style.height = `${Math.max(2, frac * 100)}%`;
}

function scrollToFraction(frac) {
  following = false;
  scroller.scrollTop = frac * scroller.scrollHeight - scroller.clientHeight / 2;
  updateJumpButton();
}

function minimapSeek(e) {
  const rect = minimap.getBoundingClientRect();
  scrollToFraction(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
}
minimap.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('bm-mark')) return;
  minimapSeek(e);
  const move = (ev) => minimapSeek(ev);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---- structured data blocks ----
// Logs print JSON and XML in the least copyable way there is: wrapped over
// dozens of lines, starting halfway along a line behind a timestamp, and
// finishing somewhere off the bottom of the screen. Detection turns each one
// into a thing you can point at — hover it, see exactly where it starts and
// ends, and copy the whole structure without dragging a selection across three
// screens of output.
const dataChip = $('out-data-copy');
const dataChipLabel = $('out-data-kind');
const dataCountEl = $('out-datacount');

let blocks = []; // { kind, sl, sc, el, ec } in absolute line numbers, sorted by start
let detectFromLine = 1; // first line whose scan could still change as output arrives
let dataOn = true;
let activeBlock = null; // the one block that's highlighted right now, + `pinned`
let paintedRows = []; // rows currently carrying block styling, so they can be cleaned
let blockStartEl = null; // the <span> at each end of the active block, for anchoring
let blockEndEl = null;

function resetBlocks() {
  blocks = [];
  detectFromLine = firstLineNo;
  setActiveBlock(null);
}

let detectScheduled = false;
function scheduleDetect() {
  if (!dataOn || detectScheduled) return;
  detectScheduled = true;
  setTimeout(() => {
    detectScheduled = false;
    runDetect();
  }, 250);
}

// Scans only the lines nobody has scanned yet, which while a process streams is
// whatever just arrived. The unterminated tail line is left out on purpose: it
// is half a line, and it becomes a committed line moments later anyway.
function runDetect() {
  if (!dataOn) return;

  // Detection resumes at an opener that hadn't closed yet last time, so the
  // ground it already covered gets walked again. Anything found there before
  // is dropped first — and the window is widened to take in whole blocks, so a
  // re-scan can never start halfway through one and cut it in two.
  let fromLine = detectFromLine;
  while (blocks.length && blocks[blocks.length - 1].el >= fromLine) {
    fromLine = Math.min(fromLine, blocks[blocks.length - 1].sl);
    blocks.pop();
  }

  const from = Math.max(0, fromLine - firstLineNo);
  if (from >= committed.length) return;

  const starts = [];
  const parts = [];
  let off = 0;
  for (let i = from; i < committed.length; i++) {
    starts.push(off);
    parts.push(committed[i].text);
    off += committed[i].text.length + 1;
  }
  const text = parts.join('\n');
  const { blocks: found, resume, more } = window.DataBlocks.detect(text);

  for (const b of found) {
    const sl = lineOfOffset(starts, b.start);
    const el = lineOfOffset(starts, b.end - 1);
    blocks.push({
      kind: b.kind,
      sl: firstLineNo + from + sl,
      sc: b.start - starts[sl],
      el: firstLineNo + from + el,
      ec: b.end - starts[el],
    });
  }
  detectFromLine = resume >= text.length
    ? firstLineNo + committed.length
    : firstLineNo + from + lineOfOffset(starts, resume);

  if (found.length) {
    updateStatus();
    scheduleMinimap();
  }
  // The pass stopped on its own budget rather than at the end of the log, so
  // the rest gets its own tick instead of waiting for output that, on a run
  // that has already finished, is never coming.
  if (more) scheduleDetect();
}

function lineOfOffset(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineTextByNo(lineNo) {
  const idx = lineNo - firstLineNo;
  if (idx >= 0 && idx < committed.length) return committed[idx].text;
  if (idx === committed.length && tail) return tail;
  return null;
}

const lastLineNo = () => firstLineNo + committed.length - (tail ? 0 : 1);

function highlightOf(lineNo) {
  const idx = lineNo - firstLineNo;
  return idx >= 0 && idx < committed.length ? committed[idx].hl : tailHl;
}

function rowFor(lineNo) {
  if (Number(tailEl.dataset.n) === lineNo) return tailEl;
  return linesEl.querySelector(`.log-line[data-n="${lineNo}"]`);
}

function inBlock(b, lineNo, col) {
  if (lineNo < b.sl || lineNo > b.el) return false;
  if (lineNo === b.sl && col < b.sc) return false;
  if (lineNo === b.el && col > b.ec) return false;
  return true;
}

// Blocks never overlap, so the containing one is at or just before the last
// block that starts on this line or earlier.
function blockAt(lineNo, col) {
  let lo = 0;
  let hi = blocks.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].sl <= lineNo) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = at; i >= 0; i--) {
    if (blocks[i].el < lineNo) break;
    if (inBlock(blocks[i], lineNo, col)) return blocks[i];
  }
  return null;
}

// The slice of one line the active block covers — a whole line in the middle of
// a block, part of one at either end.
function blockRangeIn(lineNo, len) {
  const b = activeBlock;
  if (!b || lineNo < b.sl || lineNo > b.el) return null;
  return {
    from: lineNo === b.sl ? Math.min(b.sc, len) : 0,
    to: lineNo === b.el ? Math.min(b.ec, len) : len,
    head: lineNo === b.sl,
    tail: lineNo === b.el,
  };
}

// Read from the model rather than the rendered rows, so what lands on the
// clipboard is the data as the process printed it — whole, in order, and
// unaffected by which lines the filters happen to be hiding.
function blockText(b) {
  const out = [];
  for (let n = b.sl; n <= b.el; n++) {
    const text = lineTextByNo(n);
    if (text === null) continue;
    out.push(text.slice(n === b.sl ? b.sc : 0, n === b.el ? b.ec : text.length));
  }
  return out.join('\n');
}

function sameBlock(a, b) {
  if (!a || !b) return a === b;
  return a.sl === b.sl && a.sc === b.sc && a.el === b.el && a.ec === b.ec && !!a.pinned === !!b.pinned;
}

function repaintLine(lineNo) {
  const row = rowFor(lineNo);
  const text = lineTextByNo(lineNo);
  if (!row || text === null) return;
  paint(row, text, blockRangeIn(lineNo, text.length));
  decorate(row, highlightOf(lineNo), lineNo); // paint() cleared the bookmark flag
}

function setActiveBlock(b) {
  if (sameBlock(activeBlock, b)) return;
  // Shading a block rebuilds the text nodes of every row it touches, and a
  // selection living in those nodes would die with them — taking Ctrl+C, the
  // one thing that must keep copying exactly what the reader chose, with it.
  // So the selection is measured in lines and columns first and laid back over
  // the new nodes after.
  const held = captureSelection();
  const stale = paintedRows;
  activeBlock = b;
  paintedRows = [];
  if (b) for (let n = b.sl; n <= b.el; n++) paintedRows.push(n);
  for (const n of stale) if (!b || n < b.sl || n > b.el) repaintLine(n);
  for (const n of paintedRows) repaintLine(n);
  restoreSelection(held);
  refreshBlockAnchors();
  refreshMatches(); // the marks in those rows are new nodes now
  positionDataChip();
  scheduleMinimap();
}

function refreshBlockAnchors() {
  const b = activeBlock;
  const head = b && rowFor(b.sl);
  const tailRow = b && rowFor(b.el);
  blockStartEl = head ? head.querySelector('.dblk-a') : null;
  blockEndEl = tailRow ? tailRow.querySelector('.dblk-z') : null;
}

const KIND_LABEL = { json: 'JSON', xml: 'XML', text: 'Data' };

// The chip sits just past the end of the block, so it reads as belonging to
// that data and not to the line it happens to share. When the end is scrolled
// out of sight it falls back to the right-hand edge, level with whatever part
// of the block is on screen — an action you can't reach is no action at all.
function positionDataChip() {
  const b = activeBlock;
  if (!b) {
    dataChip.classList.add('hidden');
    return;
  }
  dataChipLabel.textContent = b.pinned ? 'Selection' : KIND_LABEL[b.kind] || 'Data';
  dataChip.classList.remove('hidden');

  const body = $('out-body').getBoundingClientRect();
  const w = dataChip.offsetWidth;
  const h = dataChip.offsetHeight;
  const end = lastRect(blockEndEl);
  let left;
  let top;
  if (end && end.top >= body.top && end.bottom <= body.bottom) {
    left = end.right - body.left + 6;
    top = end.top - body.top - 1;
  } else {
    const start = lastRect(blockStartEl);
    left = Infinity;
    top = start ? start.top - body.top : 6;
  }
  dataChip.style.left = `${Math.max(4, Math.min(left, body.width - w - 22))}px`;
  dataChip.style.top = `${Math.max(4, Math.min(top, body.height - h - 4))}px`;
}

// The last of a wrapped element's rects: with Wrap on, a block's final span can
// fold over several visual lines and only the last one ends where the data does.
function lastRect(el) {
  if (!el) return null;
  const rects = el.getClientRects();
  return rects.length ? rects[rects.length - 1] : null;
}

// ---- pointing at a block ----
function offsetInRow(row, node, offset) {
  if (node === row) return 0;
  let total = 0;
  const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (n === node) return total + offset;
    if (!n.parentElement.closest('.bm-flag')) total += n.nodeValue.length;
  }
  return total;
}

// Where a DOM point falls in the log: which line, and which character along it.
// The character matters — a block that starts mid-line must light up only when
// the pointer is actually on the data, not on the timestamp in front of it.
function posOf(node, offset) {
  if (!node) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const row = el && el.closest ? el.closest('.log-line') : null;
  if (!row || !row.dataset.n) return null;
  return { lineNo: Number(row.dataset.n), col: offsetInRow(row, node, offset) };
}

// The other direction: the text node and offset a line-and-column lands on.
function pointInRow(row, col) {
  if (!row) return null;
  const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let total = 0;
  let last = null;
  let n;
  while ((n = walk.nextNode())) {
    if (n.parentElement.closest('.bm-flag')) continue;
    if (col <= total + n.nodeValue.length) return { node: n, offset: col - total };
    total += n.nodeValue.length;
    last = n;
  }
  return last ? { node: last, offset: last.nodeValue.length } : { node: row, offset: 0 };
}

function captureSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!scroller.contains(range.commonAncestorContainer)) return null;
  const a = posOf(range.startContainer, range.startOffset);
  const z = posOf(range.endContainer, range.endOffset);
  return a && z ? { a, z } : null;
}

function restoreSelection(held) {
  if (!held) return;
  const a = pointInRow(rowFor(held.a.lineNo), held.a.col);
  const z = pointInRow(rowFor(held.z.lineNo), held.z.col);
  if (!a || !z) return;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(z.node, z.offset);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function posFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const cp = document.caretPositionFromPoint(x, y);
    return cp ? posOf(cp.offsetNode, cp.offset) : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? posOf(r.startContainer, r.startOffset) : null;
  }
  return null;
}

// Leaving a block doesn't drop it straight away: the copy chip sits a few
// pixels past the end of the data, and the pointer has to cross that gap.
let hoverClearTimer = null;
function scheduleBlockClear() {
  if (hoverClearTimer || !activeBlock || activeBlock.pinned) return;
  hoverClearTimer = setTimeout(() => {
    hoverClearTimer = null;
    if (!activeBlock || !activeBlock.pinned) setActiveBlock(null);
  }, 220);
}

scroller.addEventListener('mousemove', (e) => {
  // A pinned block came from the reader's own selection and outranks whatever
  // the pointer happens to sweep over on its way to the copy chip.
  if (!dataOn || (activeBlock && activeBlock.pinned)) return;
  const pos = posFromPoint(e.clientX, e.clientY);
  const hit = pos ? blockAt(pos.lineNo, pos.col) : null;
  if (hit) {
    clearTimeout(hoverClearTimer);
    hoverClearTimer = null;
    setActiveBlock(hit);
  } else {
    scheduleBlockClear();
  }
});

dataChip.addEventListener('mouseenter', () => {
  clearTimeout(hoverClearTimer);
  hoverClearTimer = null;
});
dataChip.addEventListener('mouseleave', scheduleBlockClear);
// Pressing the chip must not collapse the reader's selection — Ctrl+C after it
// should still copy exactly what they had selected.
dataChip.addEventListener('mousedown', (e) => e.preventDefault());
dataChip.addEventListener('click', async () => {
  if (!activeBlock) return;
  await navigator.clipboard.writeText(blockText(activeBlock));
  const was = dataChipLabel.textContent;
  dataChipLabel.textContent = 'Copied';
  setTimeout(() => { dataChipLabel.textContent = was; }, 1200);
});

// ---- selection as the correction ----
// Detection is a guess, and on a log full of half-escaped output it will
// sometimes guess wrong. So the reader gets the last word: select any part of
// the data and the viewer looks outwards from the selection for a structure
// that contains it, broken syntax and all. Ctrl+C still copies precisely what
// was selected; the chip copies the whole block that was worked out from it.
const SEL_WINDOW = 400; // lines either side of the selection worth searching

let selTimer = null;
// Held back until the drag ends. Expanding mid-drag would relay the selection
// under the reader's own mouse button while they're still choosing where it
// ends, and every extra character would do it again.
let dragging = false;

function scheduleSelectionCheck(delay) {
  clearTimeout(selTimer);
  selTimer = setTimeout(handleSelection, delay);
}

scroller.addEventListener('mousedown', () => { dragging = true; });
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (dataOn) scheduleSelectionCheck(30);
});
document.addEventListener('selectionchange', () => {
  if (!dataOn || dragging) return;
  scheduleSelectionCheck(200);
});

function unpin() {
  if (activeBlock && activeBlock.pinned) setActiveBlock(null);
}

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) {
    unpin();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!scroller.contains(range.commonAncestorContainer)) return;

  const text = sel.toString();
  if (text.trim().length < 2) {
    unpin();
    return;
  }
  const from = posOf(range.startContainer, range.startOffset);
  const to = posOf(range.endContainer, range.endOffset);
  if (!from || !to) return;
  const found = expandSelection(from, to);
  if (!found) return;

  // A structure found around the selection speaks for itself — a bare `5432`
  // inside an XML document is still a request for that document. The
  // whole-lines fallback has no such backing, so it's only offered when the
  // selection itself looks like data; otherwise picking a word out of a
  // sentence would shade the sentence.
  if (found.kind === 'text' && !(/[{}[\]<>":=,]/.test(text) || text.includes('\n'))) {
    unpin();
    return;
  }
  setActiveBlock(found);
}

function expandSelection(a, z) {
  const from = Math.max(firstLineNo, a.lineNo - SEL_WINDOW);
  const to = Math.min(lastLineNo(), z.lineNo + SEL_WINDOW);
  const starts = [];
  const parts = [];
  let off = 0;
  for (let n = from; n <= to; n++) {
    const text = lineTextByNo(n);
    if (text === null) break;
    starts.push(off);
    parts.push(text);
    off += text.length + 1;
  }
  if (a.lineNo - from >= starts.length || z.lineNo - from >= starts.length) return null;

  const text = parts.join('\n');
  const b = window.DataBlocks.expand(text, starts[a.lineNo - from] + a.col, starts[z.lineNo - from] + z.col);
  if (!b) return null;
  const sl = lineOfOffset(starts, b.start);
  const el = lineOfOffset(starts, Math.max(b.start, b.end - 1));
  return {
    kind: b.kind,
    sl: from + sl,
    sc: b.start - starts[sl],
    el: from + el,
    ec: b.end - starts[el],
    pinned: true,
  };
}

// ---- floating panel ----
function renderPanel() {
  const rows = [];
  for (const rule of rules) {
    const n = counts.get(rule.id) || 0;
    rows.push(panelRow({
      color: rule.colorValue,
      label: rule.label || rule.id,
      count: n,
      off: hiddenHighlights.has(rule.id),
      onToggle: () => {
        if (hiddenHighlights.has(rule.id)) hiddenHighlights.delete(rule.id);
        else hiddenHighlights.add(rule.id);
        rerenderAll();
      },
    }));
  }
  $('panel-highlights').replaceChildren(...(rows.length ? rows : [emptyNote('No highlights configured.')]));

  const bmCounts = new Map();
  for (const bm of bookmarks.values()) bmCounts.set(bm.color, (bmCounts.get(bm.color) || 0) + 1);
  const bmRows = bookmarkColors
    .filter((c) => bmCounts.get(c.name))
    .map((c) => panelRow({
      color: c.value,
      label: c.name,
      count: bmCounts.get(c.name),
      off: hiddenBookmarks.has(c.name),
      solid: true,
      onToggle: () => {
        if (hiddenBookmarks.has(c.name)) hiddenBookmarks.delete(c.name);
        else hiddenBookmarks.add(c.name);
        rerenderAll();
      },
    }));
  $('panel-bookmarks').replaceChildren(...(bmRows.length ? bmRows : [emptyNote('No bookmarks yet.')]));

  $('panel-others').replaceChildren(panelRow({
    color: 'transparent',
    label: 'Other lines',
    count: countOthers(),
    off: !showOthers,
    onToggle: () => { showOthers = !showOthers; rerenderAll(); },
  }));
}

// All / None cover the whole Highlights section, "Other lines" included — so
// None really does empty the view and All really does bring everything back,
// rather than leaving one stray category behind.
$('panel-all').addEventListener('click', () => {
  hiddenHighlights.clear();
  showOthers = true;
  rerenderAll();
});
$('panel-none').addEventListener('click', () => {
  for (const rule of rules) hiddenHighlights.add(rule.id);
  showOthers = false;
  rerenderAll();
});

// Lines with neither a highlight nor a bookmark. Counts the unterminated tail
// too, so the panel's numbers add up to the line total in the status bar.
function countOthers() {
  let n = 0;
  for (let i = 0; i < committed.length; i++) {
    if (!committed[i].hl && !bookmarks.get(firstLineNo + i)) n++;
  }
  if (tail && !tailHl && !bookmarks.get(firstLineNo + committed.length)) n++;
  return n;
}

function emptyNote(text) {
  return Object.assign(document.createElement('div'), { className: 'panel-empty', textContent: text });
}

function panelRow({ color, label, count, off, solid, onToggle }) {
  const row = document.createElement('button');
  row.className = 'panel-row';
  row.classList.toggle('off', off);
  const dot = document.createElement('span');
  dot.className = solid ? 'panel-dot solid' : 'panel-dot';
  dot.style.backgroundImage = color === 'transparent' ? '' : `linear-gradient(${color}, ${color})`;
  const name = document.createElement('span');
  name.className = 'panel-name';
  name.textContent = label;
  row.append(dot, name);
  if (count !== null) {
    row.appendChild(Object.assign(document.createElement('span'), {
      className: 'panel-count', textContent: count.toLocaleString(),
    }));
  }
  row.onclick = onToggle;
  return row;
}

// ---- bookmarks ----
let bmSaveTimer = null;
function saveBookmarks() {
  clearTimeout(bmSaveTimer);
  bmSaveTimer = setTimeout(() => {
    fetch(`/api/executions/${execId}/bookmarks`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarks: Object.fromEntries(bookmarks) }),
    });
  }, 400);
}

// `patch` merges into the existing bookmark, so setting a colour keeps the
// comment and vice versa. Passing null removes the bookmark outright.
function setBookmark(lineNo, patch) {
  if (patch === null) {
    bookmarks.delete(lineNo);
  } else {
    const existing = bookmarks.get(lineNo) || { color: bookmarkColors[0].name };
    bookmarks.set(lineNo, { ...existing, ...patch });
  }
  saveBookmarks();

  const row = linesEl.querySelector(`.log-line[data-n="${lineNo}"]`) || (Number(tailEl.dataset.n) === lineNo ? tailEl : null);
  if (row) {
    const idx = lineNo - firstLineNo;
    decorate(row, idx >= 0 && idx < committed.length ? committed[idx].hl : tailHl, lineNo);
  }
  positionBookmarkWidget(hoveredLineNo);
  updateStatus();
  scheduleMinimap();
}

let hoveredLineNo = null;
// While a comment is being typed the widget is pinned to its line, or moving
// the mouse a few pixels would re-anchor it to another row mid-sentence.
const isEditing = () => bmWidget.contains(document.activeElement);

scroller.addEventListener('mouseover', (e) => {
  const row = e.target.closest && e.target.closest('.log-line');
  if (!row || isEditing()) return;
  hoveredLineNo = Number(row.dataset.n);
  positionBookmarkWidget(hoveredLineNo, row);
});
$('out-body').addEventListener('mouseleave', () => {
  scheduleBlockClear();
  if (isEditing()) return;
  hoveredLineNo = null;
  bmWidget.classList.add('hidden');
});

function positionBookmarkWidget(lineNo, row) {
  if (lineNo === null) {
    bmWidget.classList.add('hidden');
    return;
  }
  row = row || linesEl.querySelector(`.log-line[data-n="${lineNo}"]`);
  if (!row) {
    bmWidget.classList.add('hidden');
    return;
  }
  const rowRect = row.getBoundingClientRect();
  const bodyRect = $('out-body').getBoundingClientRect();
  bmWidget.style.top = `${rowRect.top - bodyRect.top}px`;
  bmWidget.classList.remove('hidden');
  const current = bookmarks.get(lineNo);
  // The icon is a plain outline until a colour is actually chosen — it only
  // fills in, in that colour, once the line is really bookmarked.
  bmWidget.classList.toggle('is-set', !!current);
  $('out-bm-btn').style.color = current ? bookmarkColor(current.color) : '';
  $('out-bm-btn').title = current ? 'Remove this bookmark' : 'Pick a colour to bookmark this line';
  const commentEl = $('out-bm-comment');
  if (document.activeElement !== commentEl) commentEl.value = (current && current.comment) || '';
  commentEl.placeholder = current ? 'Add a comment…' : 'Pick a colour first';
  commentEl.disabled = !current;
  for (const sw of bmColorsEl.children) {
    sw.classList.toggle('selected', !!current && sw.dataset.color === current.color);
  }
}

function buildBookmarkPicker() {
  bmColorsEl.replaceChildren(...bookmarkColors.map((c) => {
    const b = document.createElement('button');
    b.className = 'bm-color';
    b.dataset.color = c.name;
    b.style.background = c.value;
    b.title = c.name;
    b.onclick = (e) => {
      e.stopPropagation();
      if (hoveredLineNo !== null) setBookmark(hoveredLineNo, { color: c.name });
    };
    return b;
  }));
}

$('out-bm-btn').addEventListener('click', () => {
  if (hoveredLineNo === null) return;
  // Straight toggle: the icon alone bookmarks with the default colour, and the
  // swatches beside it are there to pick a different one or change it later.
  setBookmark(hoveredLineNo, bookmarks.get(hoveredLineNo) ? null : { color: bookmarkColors[0].name });
});

const commentField = $('out-bm-comment');
const commitComment = () => {
  if (hoveredLineNo === null || !bookmarks.get(hoveredLineNo)) return;
  setBookmark(hoveredLineNo, { comment: commentField.value.trim() });
};
commentField.addEventListener('change', commitComment);
commentField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { commitComment(); commentField.blur(); }
  else if (e.key === 'Escape') { commentField.value = ''; commentField.blur(); }
});
commentField.addEventListener('blur', () => {
  commitComment();
  if (!bmWidget.matches(':hover')) bmWidget.classList.add('hidden');
});

// ---- controls ----
function toggleButton(btn, get, set) {
  btn.classList.toggle('active', get());
  btn.addEventListener('click', () => {
    set(!get());
    btn.classList.toggle('active', get());
    applyFilterChange();
  });
}

let searchTimer = null;
searchField.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    search = searchField.value;
    applyFilterChange();
  }, 120);
});
searchField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    searchField.value = '';
    search = '';
    applyFilterChange();
  }
});

toggleButton($('out-regex'), () => useRegex, (v) => { useRegex = v; });
toggleButton($('out-case'), () => caseSensitive, (v) => { caseSensitive = v; });
// A real checkbox, not a chip: this one filters the log rather than changing
// how the search itself matches, so it reads better as something ticked on.
$('out-only').addEventListener('change', () => {
  onlyMatches = $('out-only').checked;
  applyFilterChange();
});
$('out-prev').addEventListener('click', () => gotoMatch(-1));
$('out-next').addEventListener('click', () => gotoMatch(1));

// Layout preferences are per-viewer taste rather than per-run, so they persist.
function persistedToggle(btn, key, defaultOn, apply) {
  const stored = localStorage.getItem(key);
  let on = stored === null ? defaultOn : stored === '1';
  const run = () => {
    btn.classList.toggle('active', on);
    apply(on);
  };
  run();
  btn.addEventListener('click', () => {
    on = !on;
    localStorage.setItem(key, on ? '1' : '0');
    run();
  });
}

persistedToggle($('out-wrap'), 'out.wrap', true, (on) => {
  scroller.classList.toggle('wrap-on', on);
  if (following) scroller.scrollTop = scroller.scrollHeight;
  scheduleMinimap();
});
// The way out when detection guesses badly on an unusual log: turn it off and
// the shading, the chip and the ruler rails all go with it.
persistedToggle($('out-data'), 'out.data', true, (on) => {
  dataOn = on;
  $('out-data').title = on ? 'Stop detecting structured data' : 'Detect JSON/XML blocks in the log';
  if (on) {
    resetBlocks();
    scheduleDetect();
  } else {
    blocks = [];
    setActiveBlock(null);
  }
  if (committed.length || tail) {
    updateStatus();
    scheduleMinimap();
  }
});
persistedToggle($('out-numbers'), 'out.numbers', false, (on) => {
  scroller.classList.toggle('show-numbers', on);
  if (following) scroller.scrollTop = scroller.scrollHeight;
});
// Stays labelled "Markup" and just lights up or doesn't, like Wrap and #.
// Relabelling it "Raw" made the button describe the state it was in rather than
// the thing it turns on, which reads backwards next to its neighbours.
//
// Off by default until this log's highlights have actually been configured:
// out of the box the seeded keywords paint nearly every line, which is noise
// rather than information. Once someone has set highlights up, they meant them.
function initMarkupToggle(configured) {
  persistedToggle($('out-markup'), 'out.markup', configured, (on) => {
    markup = on;
    if (committed.length || tail) rerenderAll();
  });
}
persistedToggle($('out-bar-toggle'), 'out.bar', true, (on) => {
  $('out-toolbar').classList.toggle('hidden', !on);
  $('out-bar-toggle').title = on ? 'Hide the toolbar' : 'Show the toolbar';
  scheduleMinimap();
});

function visibleText() {
  const out = [];
  for (let i = 0; i < committed.length; i++) {
    const line = committed[i];
    if (isVisible(line.text, line.hl, firstLineNo + i)) out.push(line.text);
  }
  const tailNo = firstLineNo + committed.length;
  if (tail && isVisible(tail, tailHl, tailNo)) out.push(tail);
  return out.join('\n');
}

$('out-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(visibleText());
  flash($('out-copy'), 'Copied');
});

$('out-save').addEventListener('click', () => {
  const blob = new Blob([visibleText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(document.title.replace('shellnote — ', '') || 'output').replace(/[^\w.#-]+/g, '_')}.log`;
  // The anchor has to be in the document, and the object URL has to outlive the
  // click: revoking it synchronously tears the blob down before the download
  // has read it, which silently produces no file at all.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

function flash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

// ---- follow lock ----
function updateJumpButton() {
  jumpBtn.classList.toggle('hidden', following);
}
scroller.addEventListener('scroll', () => {
  following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  updateJumpButton();
  updateViewportBox();
  if (hoveredLineNo !== null) positionBookmarkWidget(hoveredLineNo);
  if (activeBlock) positionDataChip();
});
jumpBtn.addEventListener('click', () => {
  following = true;
  scroller.scrollTop = scroller.scrollHeight;
  updateJumpButton();
});
window.addEventListener('resize', () => scheduleMinimap());

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    searchField.focus();
    searchField.select();
  } else if (e.key === 'Escape' && activeBlock && activeBlock.pinned) {
    // Only ever drops the block the reader pinned, so Escape in the search box
    // still means "clear the search".
    setActiveBlock(null);
  }
});

// ---- settings dialog ----
const settingsModal = $('out-settings-modal');
let hlEditor = null;
$('out-settings').addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
  if (!hlEditor) {
    hlEditor = window.HighlightEditor.create({
      root: $('out-hl-root'),
      query: `?execId=${encodeURIComponent(execId)}`,
      // Deepest first: a rule saved here defaults to affecting only this run,
      // which is the least surprising thing to do from inside one log.
      scopes: [
        { id: 'log', label: 'This log only', short: 'log' },
        { id: 'note', label: 'This note', short: 'note' },
        { id: 'global', label: 'Everywhere', short: 'all' },
      ],
      onSaved: () => loadHighlights(),
    });
  }
  hlEditor.reload();
});
$('out-settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

async function loadHighlights() {
  const data = await fetch(`/api/log-view-settings?execId=${encodeURIComponent(execId)}`).then((r) => r.json());
  setRules(data.resolved);
  bookmarkColors = data.bookmarkColors;
  buildBookmarkPicker();
  // Rules changed, so every line's highlight has to be worked out again.
  for (const line of committed) line.hl = matchHighlight(line.text);
  tailHl = tail ? matchHighlight(tail) : null;
  recount();
  rerenderAll();
}

// ---- stdin ----
async function sendStdin(eof) {
  const payload = eof ? { eof: true } : { text: stdinField.value };
  const res = await fetch(`/api/executions/${execId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok && !eof) stdinField.value = '';
}
$('out-stdin-send').addEventListener('click', () => sendStdin(false));
$('out-stdin-eof').addEventListener('click', () => sendStdin(true));
stdinField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendStdin(false);
});

// ---- wiring ----
if (!execId) {
  meta.textContent = 'No execution id given.';
} else {
  init();
}

async function init() {
  const [record, settings, savedBookmarks] = await Promise.all([
    fetch(`/api/executions/${execId}`).then((r) => r.json()),
    fetch(`/api/log-view-settings?execId=${encodeURIComponent(execId)}`).then((r) => r.json()),
    fetch(`/api/executions/${execId}/bookmarks`).then((r) => r.json()),
  ]);

  setRules(settings.resolved);
  bookmarkColors = settings.bookmarkColors;
  bookmarks = new Map(Object.entries(savedBookmarks).map(([k, v]) => [
    Number(k),
    typeof v === 'string' ? { color: v } : v, // bookmarks saved before comments existed
  ]));
  buildBookmarkPicker();

  // "Configured" means some rule is stored at a real level rather than still
  // being an untouched built-in — that's the signal that highlights were
  // deliberately set up for this log, this note, or globally.
  initMarkupToggle(settings.resolved.some((r) => r.scope && r.scope !== 'default'));

  renderMeta(record);
  resetModel();
  ingest((record.output || '').slice(-MAX_OUTPUT_CHARS));
  recount();
  render();

  if (record.status !== 'running') return;

  killBtn.classList.remove('hidden');
  stdinRow.classList.remove('hidden');
  killBtn.onclick = () => fetch(`/api/executions/${execId}/kill`, { method: 'POST' });

  const es = new EventSource(`/api/executions/${execId}/stream`);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.snapshot !== undefined) {
      resetModel();
      counts = new Map();
      ingest(msg.snapshot.slice(-MAX_OUTPUT_CHARS));
    } else if (msg.chunk !== undefined) {
      ingest(msg.chunk);
    }
    scheduleRender();
  };
  es.addEventListener('done', (e) => {
    const { status } = JSON.parse(e.data);
    renderMeta({ ...record, status });
    killBtn.classList.add('hidden');
    stdinRow.classList.add('hidden');
    render();
    es.close();
  });
  es.onerror = () => es.close();
}

function renderMeta(record) {
  document.title = `shellnote — ${record.noteTitle || record.noteFile || 'output'} #${record.blockIndex}`;
  dot.className = `status-dot ${record.status}`;
  meta.textContent = `${record.noteTitle || record.noteFile} · block #${record.blockIndex} · ${record.shell} · ${record.status}`;
}
