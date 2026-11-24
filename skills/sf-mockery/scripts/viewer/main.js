// Mockery viewer entry: boot, keyboard, clicks, and hot-reload dispatch (or static bundle mode).
import { createCamera } from './camera.js';
import { loadSharedStyles, isSharedStyle, invalidate } from './screens.js';
import * as renderer from './renderer.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const isStaticBundle = Boolean(window.__MOCKERY_BUNDLE__);

function safeGetTheme() {
  try { return localStorage.getItem('mockery:theme') || 'dark'; } catch { return 'dark'; }
}

function safeSetTheme(next) {
  try { localStorage.setItem('mockery:theme', next); } catch { /* ignore */ }
}

function safeReplaceHash(hash) {
  try {
    if (hash) history.replaceState(null, '', `#${hash}`);
    else history.replaceState(null, '', location.pathname + location.search);
  } catch { /* ignore file:// restrictions */ }
}

document.documentElement.dataset.theme = safeGetTheme();

const camera = createCamera(viewport, $('world'), {
  storeKey: `mockery:camera:${document.documentElement.dataset.project}`, // one saved view per project
  onChange(cam) {
    renderer.setCamera(cam, viewport.clientWidth, viewport.clientHeight);
    $('zoom').textContent = `${Math.round(cam.s * 100)}%`;
  },
  onTap(path) {
    const frameId = path.find((el) => el.classList?.contains('frame'))?.dataset.id;
    const goto = path.find((el) => el.dataset?.goto)?.dataset.goto;
    // First click focuses a frame; clicking a [data-goto] inside the focused frame follows the link.
    if (frameId && frameId === renderer.selected() && goto && renderer.frames.has(goto)) focus(goto);
    else if (frameId) focus(frameId);
  },
});

function focus(id, animate = true) {
  const rect = renderer.focusRect(id);
  if (!rect) return;
  renderer.select(id);
  safeReplaceHash(id);
  camera.fit(rect, { pad: 40, animate });
}

function fitAll(animate = true) {
  const b = renderer.bounds();
  if (b) camera.fit(b, { pad: 60, animate });
}

async function loadFlow() {
  try {
    if (isStaticBundle) {
      renderer.setFlow(window.__MOCKERY_BUNDLE__.flow);
      toast('');
      return;
    }
    const res = await fetch('/flow.json', { cache: 'no-store' });
    renderer.setFlow(await res.json());
    toast('');
  } catch (err) {
    toast(`flow.json: ${err.message}`);
  }
}

// ---- hot reload -------------------------------------------------------------

async function onFileChange(path) {
  if (isSharedStyle(path)) {
    await loadSharedStyles();      // swaps the adopted sheet in place: no screen re-fetch
    renderer.remeasure();          // tokens can move buttons, so re-anchor arrows
  } else if (path === 'flow.json') {
    await loadFlow();              // layout, sections and arrows only
  } else if (/^components\/.+\.html$/.test(path)) {
    const name = invalidate(path);
    renderer.rerender((f) => f.deps.has(name));
  } else if (/^screens\/.+\.html$/.test(path)) {
    invalidate(path);
    renderer.rerender((f) => f.node.file === path);
  } else if (path.startsWith('__mockery/') || path === 'fonts.css') {
    location.reload();             // viewer code or document-level fonts changed; camera is restored from storage
    return;
  } else {
    return;
  }
  flash(`↻ ${path}`);
}

async function refreshAll() {
  invalidate('*');
  await Promise.all([loadSharedStyles(), loadFlow()]);
  renderer.rerender(() => true);
}

if (isStaticBundle) {
  const statusEl = $('status');
  statusEl.className = 'is-static';
  statusEl.title = 'Standalone exported preview (offline, no server required)';
} else {
  const events = new EventSource('/__events');
  let wasDown = false;
  events.onmessage = (ev) => onFileChange(JSON.parse(ev.data).path);
  events.onopen = () => { $('status').className = 'is-live'; if (wasDown) refreshAll(); wasDown = false; };
  events.onerror = () => { $('status').className = 'is-down'; wasDown = true; };
}

// ---- keyboard -----------------------------------------------------------------

addEventListener('keydown', (e) => {
  const actions = {
    '0': () => fitAll(),
    '1': () => camera.zoomTo(1),
    '=': () => camera.zoomBy(1.25),
    '+': () => camera.zoomBy(1.25),
    '-': () => camera.zoomBy(0.8),
    '_': () => camera.zoomBy(0.8),
    f: () => renderer.selected() && focus(renderer.selected()),
    t: () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      safeSetTheme(next);
    },
    Escape: () => { renderer.select(null); safeReplaceHash(''); },
    ArrowLeft: () => camera.pan(120, 0),
    ArrowRight: () => camera.pan(-120, 0),
    ArrowUp: () => camera.pan(0, 120),
    ArrowDown: () => camera.pan(0, -120),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  const zoomKey = ['0', '=', '+', '-', '_'].includes(e.key);
  if (!action || ((e.metaKey || e.ctrlKey) && !zoomKey) || e.altKey) return;
  e.preventDefault(); // also stops browser zoom on cmd/ctrl +/-/0
  action();
});

addEventListener('hashchange', () => focus(decodeURIComponent(location.hash.slice(1))));

// ---- HUD ------------------------------------------------------------------------

let flashTimer = 0;
function flash(text) {
  const el = $('flash');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('is-on'), 1200);
}
const toast = (text) => { $('toast').textContent = text; };

// ---- boot -----------------------------------------------------------------------

await Promise.all([loadSharedStyles(), loadFlow()]);
const hashId = decodeURIComponent(location.hash.slice(1));
const isReload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
if (hashId && renderer.focusRect(hashId) && !isReload) focus(hashId, false);
else if (!camera.restore()) fitAll(false);
if (hashId) renderer.select(hashId);
