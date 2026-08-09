document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') === 'light' ? 'light' : 'dark');

const params = new URLSearchParams(location.search);
const execId = params.get('execId');
const dot = document.getElementById('out-dot');
const meta = document.getElementById('out-meta');
const full = document.getElementById('out-full');
const killBtn = document.getElementById('out-kill');

const MAX_OUTPUT_CHARS = 1_000_000;
let fullOutput = '';
let renderScheduled = false;

// setTimeout, not requestAnimationFrame — RAF is fully paused by browsers for
// background/inactive windows, which is exactly the common case for this pop-out
// (user switches back to the main tab while a long job keeps running here).
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    full.textContent = fullOutput;
    full.scrollTop = full.scrollHeight;
  }, 150);
}

if (!execId) {
  meta.textContent = 'No execution id given.';
} else {
  init();
}

async function init() {
  const record = await fetch(`/api/executions/${execId}`).then((r) => r.json());
  render(record);
  fullOutput = (record.output || '').slice(-MAX_OUTPUT_CHARS);
  scheduleRender();

  if (record.status !== 'running') return;

  killBtn.classList.remove('hidden');
  killBtn.onclick = () => fetch(`/api/executions/${execId}/kill`, { method: 'POST' });

  const es = new EventSource(`/api/executions/${execId}/stream`);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.snapshot !== undefined) fullOutput = msg.snapshot.slice(-MAX_OUTPUT_CHARS);
    else if (msg.chunk !== undefined) {
      fullOutput += msg.chunk;
      if (fullOutput.length > MAX_OUTPUT_CHARS) fullOutput = fullOutput.slice(-MAX_OUTPUT_CHARS);
    }
    scheduleRender();
  };
  es.addEventListener('done', (e) => {
    const { status } = JSON.parse(e.data);
    dot.className = `status-dot ${status}`;
    killBtn.classList.add('hidden');
    full.textContent = fullOutput;
    full.scrollTop = full.scrollHeight;
    es.close();
  });
  es.onerror = () => es.close();
}

function render(record) {
  document.title = `shellnote — ${record.noteTitle || record.noteFile || 'output'} #${record.blockIndex}`;
  dot.className = `status-dot ${record.status}`;
  meta.textContent = `${record.noteTitle || record.noteFile} · block #${record.blockIndex} · ${record.shell} · ${record.status}`;
}
