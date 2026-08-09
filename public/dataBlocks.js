// Finds structured data — JSON/JS-ish objects and arrays, XML/HTML — inside a
// log. Logs print structures in the worst possible way: wrapped over dozens of
// lines, starting halfway through a line behind a timestamp, and with values
// that were never escaped. Selecting one by hand is miserable, so the viewer
// detects the block and copies it whole.
//
// The scanners are deliberately *lenient*. This is a "help me copy that" tool,
// not a validator: a string that never closes, a `}` that closes a `[`, or a
// stray `<` in the middle of content must not throw the scan off, because the
// text the user wants is still sitting right there. Anything that stays
// balanced enough to find an end is good enough to offer.
//
// Everything here works on one flat string of joined lines and returns flat
// offsets; the caller maps those back to lines. That keeps the scanning a
// single pass over a plain string instead of a walk over a line array with a
// two-part cursor, and it makes the whole module pure and testable.
(function () {
  const MAX_BLOCK = 120_000; // longest run of text a single block may cover
  const BUDGET = 1_500_000; // chars one detect() pass may look at before giving up
  const LOOKBACK = 20_000; // how far back a selection may reach for its opener

  const NAME_START = /[A-Za-z_]/;
  const NAME = /^[A-Za-z_][\w.:-]*/;
  const WS = /\s/;

  // Void HTML elements never close, so a stack that waits for `</br>` would
  // swallow the rest of the document.
  const VOID = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  // ---- JSON / brace-and-bracket structures ----
  // Depth counting with string awareness. Quotes are closed at every newline:
  // real JSON never breaks a string across lines, and a log that printed an
  // unbalanced quote shouldn't take the rest of the file hostage.
  //
  // `loose` drops string tracking altogether and counts nothing but brackets.
  // That's wrong for well-formed data — a `}` inside a string would end the
  // block early — so it's never used for detection. It exists for the case
  // where the reader has selected data we couldn't parse, which in practice
  // means a value with an unescaped quote in it: ignoring quotes is exactly
  // what finds the ends of `{"msg": "he said "no""}`.
  function scanJson(text, start, loose) {
    const max = Math.min(text.length, start + MAX_BLOCK);
    let depth = 0;
    let inStr = false;
    let quote = '';
    let esc = false;
    let commas = 0;
    let colons = 0;
    let keyish = false; // saw `"something":` — the strongest signal there is
    let nested = false;
    let multiline = false;

    for (let p = start; p < max; p++) {
      const c = text[p];
      if (c === '\n') {
        multiline = true;
        inStr = false;
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) {
          inStr = false;
          let q = p + 1;
          while (q < max && (text[q] === ' ' || text[q] === '\t')) q++;
          if (text[q] === ':') keyish = true;
        }
        continue;
      }
      if (!loose && (c === '"' || c === "'")) {
        inStr = true;
        quote = c;
        esc = false;
      } else if (c === '{' || c === '[') {
        depth++;
        if (depth > 1) nested = true;
      } else if (c === '}' || c === ']') {
        depth--;
        if (depth <= 0) {
          const end = p + 1;
          const strong = keyish || commas >= 2 || (multiline && (colons > 0 || commas > 0 || nested));
          // The length floor is what keeps `[INFO]`, `[ok]` and `{}` out.
          return { status: end - start >= 12 && strong ? 'ok' : 'weak', kind: 'json', start, end };
        }
      } else if (c === ',') commas++;
      else if (c === ':') colons++;
    }
    // Ran out of text: more output may still close it, unless we hit the cap.
    return { status: max === text.length ? 'eof' : 'toolong' };
  }

  // ---- XML / HTML ----
  // Reads one `<…>` token. Returns null when it isn't markup at all, so a bare
  // `<` in prose ("a < b") is stepped over rather than derailing the scan.
  function readTag(text, at, max) {
    const two = text.slice(at, at + 2);
    const skipTo = (marker) => {
      const i = text.indexOf(marker, at);
      if (i < 0 || i + marker.length > max) return { truncated: true };
      return { kind: 'skip', end: i + marker.length };
    };
    if (two === '<!') {
      if (text.startsWith('<!--', at)) return skipTo('-->');
      if (text.startsWith('<![CDATA[', at)) return skipTo(']]>');
      return skipTo('>'); // doctype
    }
    if (two === '<?') return skipTo('?>');

    const closing = two === '</';
    const nameAt = at + (closing ? 2 : 1);
    if (!NAME_START.test(text[nameAt] || '')) return null;
    const name = (NAME.exec(text.slice(nameAt, nameAt + 80)) || [''])[0];
    // A tag name is followed by an attribute, a `/` or the `>` — nothing else.
    // Without this, source code like `if (a<b) return c>d` reads as a `<b>`
    // element and swallows everything up to the next `>`.
    if (!/[\s/>]/.test(text[nameAt + name.length] || '')) return null;

    // Walk to the tag's `>`, stepping over quoted attribute values so that a
    // `>` inside one (href="a>b") doesn't end the tag early.
    let p = nameAt + name.length;
    let q = '';
    while (p < max) {
      const c = text[p];
      if (q) {
        if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') {
        const self = text[p - 1] === '/' || (!closing && VOID.has(name.toLowerCase()));
        return { kind: closing ? 'close' : self ? 'self' : 'open', name, end: p + 1 };
      } else if (c === '<') return null; // a `<` before the `>`: not a tag after all
      p++;
    }
    return { truncated: true };
  }

  function scanXml(text, start) {
    const max = Math.min(text.length, start + MAX_BLOCK);
    const stack = [];
    const outOf = () => ({ status: max === text.length ? 'eof' : 'toolong' });
    const done = (end, tags) => {
      const nl = text.indexOf('\n', start);
      const multiline = nl >= 0 && nl < end;
      const strong = tags >= 2 || (multiline && tags >= 1);
      return { status: end - start >= 12 && strong ? 'ok' : 'weak', kind: 'xml', start, end };
    };

    let p = start;
    let lastEnd = start;
    let tags = 0;
    let opened = false;

    while (p < max) {
      if (stack.length) {
        const lt = text.indexOf('<', p);
        if (lt < 0 || lt >= max) return outOf();
        p = lt;
      } else if (p > start) {
        // Back at the top level. Only whitespace may hold the pieces of one
        // document together — anything else means the markup ended here.
        let q = p;
        while (q < max && WS.test(text[q])) q++;
        if (text[q] !== '<') return done(lastEnd, tags);
        p = q;
      }

      const tag = readTag(text, p, max);
      if (!tag) {
        if (!stack.length) return done(lastEnd, tags);
        p++; // stray `<` inside content
        continue;
      }
      if (tag.truncated) return outOf();
      p = tag.end;
      lastEnd = tag.end;
      if (tag.kind !== 'skip') tags++;

      if (tag.kind === 'open') {
        stack.push(tag.name);
        opened = true;
      } else if (tag.kind === 'self') {
        opened = true;
      } else if (tag.kind === 'close') {
        // Lenient: a close tag pops everything above its own opener, so one
        // forgotten `</div>` doesn't unbalance the rest of the document.
        const k = stack.lastIndexOf(tag.name);
        if (k >= 0) stack.length = k;
        if (opened && !stack.length) return done(tag.end, tags);
      }
    }
    return outOf();
  }

  function scanAt(text, p, loose) {
    const c = text[p];
    if (c === '{' || c === '[') return scanJson(text, p, loose);
    if (c !== '<') return null;
    const n = text[p + 1];
    if (!n || !(NAME_START.test(n) || n === '!' || n === '?' || n === '/')) return null;
    return scanXml(text, p);
  }

  // ---- detection over a whole span of log ----
  // `resume` marks where the next pass should start over: an opener that ran
  // out of text may still be a block once the rest of it streams in, so that
  // stretch has to be scanned again rather than trusted.
  //
  // Scanning carries on past it regardless, and the blocks after it come back
  // in this pass's results. A log full of `${VAR}`, `awk '{print}'` and
  // half-quoted junk throws off openers that will never close, and a finished
  // log never gets the extra text that would settle them — stopping at the
  // first one would hide every structure printed after it, which on a finished
  // run means hiding it for good.
  //
  // The wait is also bounded: once an opener is STALL_LIMIT chars behind the
  // end it stops being a maybe and the mark moves on for good.
  const STALL_LIMIT = 20_000;

  function detect(text) {
    const blocks = [];
    let used = 0;
    let pending = -1;
    for (let p = 0; p < text.length; p++) {
      const c = text[p];
      if (c !== '{' && c !== '[' && c !== '<') continue;
      const r = scanAt(text, p);
      if (!r) continue;
      // What the scan actually read — a candidate that ran to the end of the
      // text cost that much and no more. Charging every failure the full cap
      // would exhaust the budget after a dozen stray braces.
      used += (r.end != null ? r.end : Math.min(text.length, p + MAX_BLOCK)) - p;
      if (r.status === 'ok') {
        blocks.push(r);
        p = r.end - 1;
      } else if (r.status === 'eof' && pending < 0 && text.length - p <= STALL_LIMIT) {
        pending = p;
      }
      // Out of budget: hand back where we stopped, not the opener we were
      // still hoping for. Resuming behind this point would re-do the same
      // expensive stretch and stop in the same place, forever.
      if (used > BUDGET) return { blocks, resume: p, more: true };
    }
    return { blocks, resume: pending < 0 ? text.length : pending, more: false };
  }

  // ---- selection-driven expansion ----
  // The escape hatch for everything detection got wrong. The user selects the
  // part they can see and we look outwards for a structure that contains it —
  // taking the *widest* one, so grabbing a value inside a nested object hands
  // back the whole document rather than the innermost pair of braces.
  const fits = (r, selEnd) => !!r && !!r.end && r.end >= selEnd && (r.status === 'ok' || r.status === 'weak');

  function expand(text, selStart, selEnd) {
    const from = Math.max(0, selStart - LOOKBACK);
    let best = null;
    let used = 0;
    for (let p = selStart; p >= from; p--) {
      const c = text[p];
      if (c !== '{' && c !== '[' && c !== '<') continue;
      // Strict first, then the bracket-only reading — the second is what gets
      // through data whose own syntax is broken, which is why we're here.
      let r = scanAt(text, p);
      if (!fits(r, selEnd)) r = scanAt(text, p, true);
      used += (r && r.end ? r.end : p) - p;
      // 'weak' counts here: the reader pointing at it is the qualification.
      if (fits(r, selEnd)) best = r;
      if (used > BUDGET) break;
    }
    return best || expandLines(text, selStart, selEnd);
  }

  // Nothing parsed, so fall back to whole lines and grow while the neighbours
  // still look like part of the same structure — indented, or opening or
  // trailing off with a structural character. Kept to a short reach on purpose:
  // this is a guess made after two parsers gave up, and a guess that runs away
  // down the log is worse than one that stops a line early.
  const STRUCTY = /^\s*["'{}[\]<>]|[,{[:>]\s*$/;
  const GROW = 40;

  function expandLines(text, selStart, selEnd) {
    let start = text.lastIndexOf('\n', Math.max(0, selStart - 1)) + 1;
    let end = text.indexOf('\n', selEnd);
    if (end < 0) end = text.length;

    for (let n = 0; n < GROW && start > 0; n++) {
      const prev = text.lastIndexOf('\n', start - 2) + 1;
      if (!STRUCTY.test(text.slice(prev, start - 1))) break;
      start = prev;
    }
    for (let n = 0; n < GROW && end < text.length; n++) {
      let next = text.indexOf('\n', end + 1);
      if (next < 0) next = text.length;
      if (!STRUCTY.test(text.slice(end + 1, next))) break;
      end = next;
    }
    return { status: 'ok', kind: 'text', start, end };
  }

  window.DataBlocks = { detect, expand };
})();
