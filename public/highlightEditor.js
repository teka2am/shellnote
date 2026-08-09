// Shared highlight editor, used by the Settings modal (global only) and by the
// pop-out's own settings dialog (where a rule can also be pinned to just this
// note or just this run). Both pages get the same list + detail layout; the
// only difference is how many scopes a rule can be stored at.
window.HighlightEditor = (function () {
  function create({ root, query = '', scopes = [{ id: 'global', label: 'Global' }], onSaved, showThemeRow = true }) {
    const multiScope = scopes.length > 1;
    const defaultScope = scopes[0].id;

    root.innerHTML = `
      <div class="hl-intro">Lines containing a keyword get that highlight's background colour. The log's own text is never recoloured.</div>
      <div class="hl-theme-row"${showThemeRow ? '' : ' hidden'}>
        <span class="settings-label">Colour theme</span>
        <select class="hl-theme"></select>
        <span class="hl-theme-hint"></span>
      </div>
      <div class="hl-layout">
        <div class="hl-list-pane">
          <div class="hl-list"></div>
          <button class="hl-add" type="button">+ Add highlight</button>
        </div>
        <div class="hl-detail"></div>
      </div>
      <div class="settings-footer hl-footer">
        <button class="hl-reset" type="button">Reset to defaults</button>
        <span class="hl-status"></span>
        <button class="hl-save primary" type="button">Save</button>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const listEl = $('.hl-list');
    const detailEl = $('.hl-detail');
    const themeEl = $('.hl-theme');
    const statusEl = $('.hl-status');

    let working = [];
    let defaults = [];
    let palette = [];
    let themes = [];
    let tombstones = new Set();
    let selectedId = null;
    let loaded = false;

    function setStatus(text) {
      statusEl.textContent = text;
      if (text) setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ''; }, 2500);
    }

    function colorFor(name) {
      return (palette.find((p) => p.name === name) || {}).highlight || 'transparent';
    }

    // Only rules that actually differ from the built-in set get written, so a
    // rule left alone keeps following the defaults instead of being frozen as
    // a copy of whatever they happened to be today.
    function isModified(rule) {
      const def = defaults.find((d) => d.id === rule.id);
      if (!def) return true; // user-added
      return def.label !== rule.label
        || def.color !== rule.color
        || def.enabled !== (rule.enabled !== false)
        || !!def.wholeWord !== !!rule.wholeWord
        || !!def.matchCase !== !!rule.matchCase
        || def.keywords.join(' ') !== (rule.keywords || []).join(' ');
    }

    async function load(force) {
      if (loaded && !force) return;
      const data = await fetch(`/api/log-view-settings${query}`).then((r) => r.json());
      palette = data.palette;
      themes = data.themes;
      defaults = data.defaults;
      working = data.resolved.map((r) => ({ ...r }));
      tombstones = new Set();
      if (!working.some((r) => r.id === selectedId)) selectedId = working.length ? working[0].id : null;
      loaded = true;

      themeEl.replaceChildren(...themes.map((t) => new Option(t.label, t.id)));
      themeEl.value = data.theme;
      themeEl.onchange = async () => {
        await fetch('/api/log-view-settings/theme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: themeEl.value }),
        });
        await load(true); // colours are theme-derived, so re-resolve them
        setStatus('Theme changed');
        if (onSaved) onSaved();
      };
      render();
    }

    function render() {
      const hint = themes.find((t) => t.id === themeEl.value);
      $('.hl-theme-hint').textContent = hint ? hint.hint : '';
      renderList();
      renderDetail();
    }

    function renderList() {
      if (!working.length) {
        listEl.replaceChildren(Object.assign(document.createElement('div'), {
          className: 'hl-list-empty', textContent: 'No highlights yet.',
        }));
        return;
      }
      listEl.replaceChildren(...working.map((rule) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'hl-item';
        item.classList.toggle('selected', rule.id === selectedId);
        item.classList.toggle('off', rule.enabled === false);

        const dot = document.createElement('span');
        dot.className = 'hl-dot';
        dot.style.backgroundImage = `linear-gradient(${colorFor(rule.color)}, ${colorFor(rule.color)})`;

        const name = document.createElement('span');
        name.className = 'hl-item-name';
        name.textContent = rule.label || rule.id;

        const count = document.createElement('span');
        count.className = 'hl-item-count';
        count.textContent = (rule.keywords || []).length;
        count.title = `${(rule.keywords || []).length} keywords`;

        item.append(dot, name, count);
        if (multiScope && rule.scope && rule.scope !== 'default') {
          item.appendChild(Object.assign(document.createElement('span'), {
            className: `hl-item-scope scope-${rule.scope}`,
            textContent: (scopes.find((s) => s.id === rule.scope) || {}).short || rule.scope,
          }));
        } else if (isModified(rule)) {
          item.appendChild(Object.assign(document.createElement('span'), {
            className: 'hl-item-mod', textContent: '*', title: 'Changed from the default',
          }));
        }
        item.onclick = () => { selectedId = rule.id; render(); };
        return item;
      }));
    }

    function renderDetail() {
      const rule = working.find((r) => r.id === selectedId);
      if (!rule) {
        detailEl.replaceChildren(Object.assign(document.createElement('div'), {
          className: 'hl-list-empty', textContent: 'Select a highlight, or add one.',
        }));
        return;
      }

      const field = (labelText, control) => {
        const wrap = document.createElement('div');
        wrap.className = 'hl-field';
        wrap.append(Object.assign(document.createElement('label'), { className: 'hl-field-label', textContent: labelText }), control);
        return wrap;
      };

      // Editing a rule that's still at its built-in default has to move it
      // somewhere real, or the change would have nowhere to be written.
      const touch = () => { if (!rule.scope || rule.scope === 'default') rule.scope = defaultScope; };

      const name = document.createElement('input');
      name.className = 'hl-name';
      name.value = rule.label || rule.id;
      name.placeholder = 'Name';
      name.oninput = () => { rule.label = name.value; touch(); renderList(); };

      // A grid of the actual colours beats a dropdown of colour names — picking
      // is the whole point, and the names mean nothing without seeing them.
      const colors = document.createElement('div');
      colors.className = 'hl-colors';
      for (const p of palette) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'hl-swatch';
        swatch.style.backgroundImage = `linear-gradient(${p.highlight}, ${p.highlight})`;
        swatch.title = p.name;
        swatch.classList.toggle('selected', p.name === rule.color);
        swatch.onclick = () => { rule.color = p.name; touch(); render(); };
        colors.appendChild(swatch);
      }

      const chips = document.createElement('div');
      chips.className = 'hl-chips';
      for (const [i, word] of (rule.keywords || []).entries()) {
        const chip = document.createElement('span');
        chip.className = 'hl-chip';
        chip.append(document.createTextNode(word));
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'hl-chip-x';
        x.textContent = '×';
        x.title = `Remove "${word}"`;
        x.onclick = () => { rule.keywords.splice(i, 1); touch(); render(); };
        chip.appendChild(x);
        chips.appendChild(chip);
      }
      const addWord = document.createElement('input');
      addWord.className = 'hl-chip-input';
      addWord.placeholder = (rule.keywords || []).length ? 'add word...' : 'type a word, press Enter';
      addWord.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ',') return;
        e.preventDefault();
        const word = addWord.value.trim().replace(/,$/, '');
        if (!word) return;
        rule.keywords = [...(rule.keywords || []), word];
        touch();
        render();
        detailEl.querySelector('.hl-chip-input').focus();
      };
      chips.appendChild(addWord);

      const opts = document.createElement('div');
      opts.className = 'hl-opts';
      for (const [key, text, title] of [
        ['enabled', 'Enabled', 'Turn this highlight off without deleting it'],
        ['wholeWord', 'Whole word', 'Match only complete words - "pass" will not match "password"'],
        ['matchCase', 'Match case', 'Require the same upper/lower case'],
      ]) {
        const wrap = document.createElement('label');
        wrap.className = 'hl-check';
        wrap.title = title;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = key === 'enabled' ? rule.enabled !== false : !!rule[key];
        box.onchange = () => { rule[key] = box.checked; touch(); render(); };
        wrap.append(box, document.createTextNode(text));
        opts.appendChild(wrap);
      }

      const preview = document.createElement('div');
      preview.className = 'hl-preview';
      const sample = document.createElement('div');
      sample.className = 'hl-preview-line';
      sample.textContent = `10:24:07  ${(rule.keywords || [])[0] || 'keyword'} - a matching line looks like this`;
      if (rule.enabled !== false) sample.style.backgroundImage = `linear-gradient(${colorFor(rule.color)}, ${colorFor(rule.color)})`;
      preview.appendChild(sample);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'hl-remove';
      remove.textContent = 'Remove highlight';
      remove.onclick = () => {
        // A built-in can't just be dropped from the list - the defaults would
        // put it straight back on the next load, so it needs a tombstone.
        if (defaults.some((d) => d.id === rule.id)) tombstones.add(rule.id);
        working = working.filter((r) => r !== rule);
        selectedId = working.length ? working[0].id : null;
        render();
      };

      const fields = [field('Name', name), field('Colour', colors), field('Keywords', chips), field('Options', opts)];

      if (multiScope) {
        const scopeSel = document.createElement('select');
        scopeSel.className = 'hl-scope';
        scopeSel.replaceChildren(...scopes.map((s) => new Option(s.label, s.id)));
        scopeSel.value = rule.scope && rule.scope !== 'default' ? rule.scope : defaultScope;
        scopeSel.onchange = () => { rule.scope = scopeSel.value; render(); };
        fields.push(field('Applies to', scopeSel));
      }

      fields.push(field('Preview', preview));
      detailEl.replaceChildren(...fields, remove);
    }

    $('.hl-add').onclick = () => {
      const id = `custom-${Date.now().toString(36)}`;
      working.push({ id, label: 'New highlight', color: 'teal', keywords: [], enabled: true, wholeWord: true, matchCase: false, scope: defaultScope });
      selectedId = id;
      render();
      detailEl.querySelector('.hl-name').select();
    };

    $('.hl-save').onclick = async () => {
      const levels = {};
      for (const s of scopes) levels[s.id] = { rules: {}, order: null };
      levels[defaultScope].order = working.map((r) => r.id);

      for (const rule of working) {
        const target = multiScope ? (rule.scope && rule.scope !== 'default' ? rule.scope : null) : (isModified(rule) ? 'global' : null);
        if (!target || !levels[target]) continue;
        if (!multiScope && !isModified(rule)) continue;
        const { scope, colorValue, ...stored } = rule;
        levels[target].rules[stored.id] = { ...stored, enabled: rule.enabled !== false };
      }
      for (const id of tombstones) levels[defaultScope].rules[id] = { deleted: true };

      const res = await fetch(`/api/log-view-settings${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ levels }),
      });
      if (!res.ok) { setStatus('Save failed'); return; }
      const changed = Object.values(levels).reduce((n, l) => n + Object.keys(l.rules).length, 0);
      await load(true);
      setStatus(changed ? `Saved - ${changed} customised` : 'Saved - all at defaults');
      if (onSaved) onSaved();
    };

    $('.hl-reset').onclick = async () => {
      if (!confirm('Reset these highlights back to the built-in defaults?')) return;
      for (const s of scopes) {
        await fetch(`/api/log-view-settings/reset${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: s.id }),
        });
      }
      await load(true);
      setStatus('Reset to defaults');
      if (onSaved) onSaved();
    };

    return { load, reload: () => load(true) };
  }

  // Turns saved rules into something the viewer can run over every line. One
  // regex per rule, built once, rather than a scan per keyword per line.
  function compile(rules) {
    return (rules || [])
      .filter((r) => r.enabled !== false && (r.keywords || []).length)
      .map((rule) => {
        const words = rule.keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const body = `(?:${words.join('|')})`;
        const source = rule.wholeWord ? `(?<![\\w-])${body}(?![\\w-])` : body;
        let re;
        try {
          re = new RegExp(source, rule.matchCase ? '' : 'i');
        } catch {
          re = new RegExp(body, rule.matchCase ? '' : 'i'); // lookbehind unsupported
        }
        return { ...rule, re };
      });
  }

  return { create, compile };
})();
