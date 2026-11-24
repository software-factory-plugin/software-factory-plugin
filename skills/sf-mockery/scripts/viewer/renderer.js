// Renderer: turns flow.json into sections, device frames (one shadow root per screen),
// titles and arrows. Handles culling and level-of-detail as the camera moves.
import { sharedSheet, renderScreen } from './screens.js';
import { drawEdges, anchorSelector } from './edges.js';

export const LOD_SCALE = 0.25;   // below this zoom, frames show a title card instead of the screen
const CULL_MARGIN = 0.5;         // frames within half a viewport of the visible area count as visible
const SECTION_PAD = 100;         // auto-sized sections: padding around member frames
const DEVICE_SIZES = { phone: [390, 844], tablet: [768, 1024], pos: [1280, 800], desktop: [1440, 900] };
const SECTION_COLORS = ['blue', 'green', 'amber', 'red', 'violet', 'gray'];
const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));

const byId = (id) => document.getElementById(id);
const layers = {
  sections: byId('sections'), frames: byId('frames'), edges: byId('edges'), labels: byId('labels'),
  sectionTitles: byId('section-titles'), frameTitles: byId('frame-titles'), edgeLabels: byId('edge-labels'),
};

export const frames = new Map();   // node id -> frame record
let flow = { nodes: [], edges: [], sections: [] };
let sectionRects = new Map();      // section id -> {x, y, w, h}
let camera = { x: 0, y: 0, s: 1 };
let view = { w: innerWidth, h: innerHeight };
let selectedId = null;

const px = (el, styles) => { for (const k in styles) el.style[k] = `${styles[k]}px`; };

function withDefaults(n) {
  const [w, h] = DEVICE_SIZES[n.device] || [800, 600];
  const node = { title: n.id, device: 'none', file: `screens/${n.id}.html`, x: 0, y: 0, w, h, ...n };
  node.file = node.file.replace(/^\.?\//, '');
  return node;
}

export function setFlow(data) {
  flow = { nodes: (data.nodes || []).map(withDefaults), edges: data.edges || [], sections: data.sections || [] };
  const ids = new Set(flow.nodes.map((n) => n.id));
  for (const [id, f] of frames) {
    if (!ids.has(id)) { f.el.remove(); f.title.remove(); frames.delete(id); }
  }
  for (const node of flow.nodes) {
    const f = frames.get(node.id) || createFrame(node.id);
    if (f.node && f.node.file !== node.file) { f.state = 'idle'; f.token++; } // remount with the new file
    place(f, node);
  }
  drawSections();
  for (const f of frames.values()) measureAnchors(f);
  updateVisibility();
  scheduleEdges();
  premount();
}

function createFrame(id) {
  const el = document.createElement('div');
  el.innerHTML = '<div class="frame-bezel"></div><div class="frame-screen"></div><div class="frame-lod"></div>';
  const host = el.children[1];
  const root = host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sharedSheet];
  const title = document.createElement('div');
  title.className = 'frame-title';
  layers.frames.append(el);
  layers.frameTitles.append(title);
  const f = { node: null, el, host, root, title, lod: el.children[2], state: 'idle', token: 0, deps: new Set(), anchors: new Map(), outer: null };
  frames.set(id, f);
  return f;
}

function place(f, n) {
  f.node = n;
  f.el.className = `frame device-${n.device}${n.id === selectedId ? ' is-selected' : ''}`;
  f.el.dataset.id = n.id;
  px(f.el, { left: n.x, top: n.y, width: n.w, height: n.h });
  f.lod.textContent = n.title;
  f.lod.style.fontSize = `${Math.round(Math.min(n.w, n.h) / 8)}px`;
  // The bezel is drawn outside the screen; measure it so arrows and titles sit on its outer edge.
  const b = f.el.firstElementChild;
  f.outer = { x: n.x + b.offsetLeft, y: n.y + b.offsetTop, w: b.offsetWidth, h: b.offsetHeight };
  f.title.textContent = n.title;
  px(f.title, { left: f.outer.x, top: f.outer.y - 12 });
}

async function mount(f) {
  const token = ++f.token;
  f.state = 'loading';
  let out;
  try {
    out = await renderScreen(f.node.file);
  } catch (err) {
    out = { html: `<div style="padding:24px;font:14px system-ui;color:#c62828">Could not load ${f.node.file}<br>${err.message}</div>`, deps: new Set() };
  }
  if (token !== f.token) return; // a newer render started meanwhile
  f.root.innerHTML = out.html;
  f.deps = out.deps;
  f.state = 'ready';
  measureAnchors(f);
  scheduleEdges();
}

// Re-render mounted frames that match (e.g. use a changed component). Unmounted ones load fresh later.
export function rerender(match) {
  for (const f of frames.values()) if (f.state !== 'idle' && match(f)) mount(f);
}

// Mount the remaining screens during idle time so arrows can start at their buttons before you zoom in.
let premounting = false;
function premount() {
  if (premounting) return;
  const next = [...frames.values()].find((f) => f.state === 'idle');
  if (!next) return;
  premounting = true;
  idle(() => mount(next).finally(() => { premounting = false; premount(); }));
}

// Record where each outgoing edge's trigger element sits, in node-local world px.
function measureAnchors(f) {
  f.anchors.clear();
  if (f.state !== 'ready') return;
  const out = flow.edges.filter((e) => e.from === f.node.id);
  if (!out.length) return;
  f.host.style.display = 'block'; // measurable even while hidden by LOD or culling
  const box = f.host.getBoundingClientRect();
  const k = f.node.w / box.width; // client px -> world px
  for (const e of out) {
    const sel = anchorSelector(e);
    let el = null;
    try { el = f.root.querySelector(sel); } catch { console.warn(`[mockery] invalid fromSelector "${sel}"`); }
    if (!el) {
      if (e.fromSelector) console.warn(`[mockery] ${e.from}: fromSelector "${sel}" matched nothing`);
      continue;
    }
    const r = el.getBoundingClientRect();
    f.anchors.set(sel, { x: (r.left - box.left) * k, y: (r.top - box.top) * k, w: r.width * k, h: r.height * k });
  }
  f.host.style.display = '';
}

export function remeasure() {
  for (const f of frames.values()) measureAnchors(f);
  scheduleEdges();
}

let edgesQueued = false;
function scheduleEdges() {
  if (edgesQueued) return;
  edgesQueued = true;
  requestAnimationFrame(() => {
    edgesQueued = false;
    drawEdges(layers.edges, layers.edgeLabels, flow.edges, frames);
  });
}

// A section uses its own x/y/w/h if given, otherwise wraps the frames whose node.section matches.
function sectionRect(s) {
  if ([s.x, s.y, s.w, s.h].every(Number.isFinite)) return { x: s.x, y: s.y, w: s.w, h: s.h };
  const rs = [...frames.values()].filter((f) => f.node.section === s.id).map((f) => f.outer);
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x)) - SECTION_PAD;
  const y = Math.min(...rs.map((r) => r.y)) - SECTION_PAD - 40; // room for frame titles
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) + SECTION_PAD - x, h: Math.max(...rs.map((r) => r.y + r.h)) + SECTION_PAD - y };
}

function drawSections() {
  sectionRects = new Map();
  const boxes = [];
  const titles = [];
  for (const s of flow.sections) {
    const r = sectionRect(s);
    if (!r) continue;
    sectionRects.set(s.id, r);
    const color = SECTION_COLORS.includes(s.color) ? `var(--section-${s.color})` : s.color || 'var(--section-gray)';
    const box = document.createElement('div');
    box.className = 'section';
    px(box, { left: r.x, top: r.y, width: r.w, height: r.h });
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = s.title || s.id;
    px(title, { left: r.x + 8, top: r.y - 14 });
    for (const el of [box, title]) el.style.setProperty('--c', color);
    boxes.push(box);
    titles.push(title);
  }
  layers.sections.replaceChildren(...boxes);
  layers.sectionTitles.replaceChildren(...titles);
}

export function setCamera(cam, w, h) {
  camera = cam;
  view = { w, h };
  // Labels and arrow strokes counter-scale via --k so they stay readable when zoomed out.
  for (const el of [layers.edges, layers.labels]) el.style.setProperty('--s', cam.s);
  updateVisibility();
}

function updateVisibility() {
  const { x, y, s } = camera;
  const mx = view.w * CULL_MARGIN;
  const my = view.h * CULL_MARGIN;
  const x0 = (-x - mx) / s, y0 = (-y - my) / s, x1 = (view.w - x + mx) / s, y1 = (view.h - y + my) / s;
  const lod = s < LOD_SCALE;
  for (const f of frames.values()) {
    const o = f.outer;
    const visible = o.x < x1 && o.x + o.w > x0 && o.y < y1 && o.y + o.h > y0;
    f.el.classList.toggle('is-culled', !visible);
    f.el.classList.toggle('is-lod', lod);
    f.title.hidden = !visible;
    if (visible && !lod && f.state === 'idle') mount(f);
  }
}

export function select(id) {
  selectedId = frames.has(id) ? id : null;
  for (const [fid, f] of frames) f.el.classList.toggle('is-selected', fid === selectedId);
}
export const selected = () => selectedId;

// World rect to fit when focusing a frame (with its title) or a section.
export function focusRect(id) {
  const f = frames.get(id);
  if (f) return { x: f.outer.x, y: f.outer.y - 48, w: f.outer.w, h: f.outer.h + 48 };
  return sectionRects.get(id) || null;
}

export function bounds() {
  const rs = [...[...frames.values()].map((f) => f.outer), ...sectionRects.values()];
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y)) - 60; // section titles sit above their box
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}
