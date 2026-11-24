// Screens: fetch screen + component files (or read from an embedded standalone bundle),
// expand <x-include>, and own the one stylesheet that every screen's shadow root adopts.

const STYLE_FILES = ['tokens.css', 'kit.css'];
export const sharedSheet = new CSSStyleSheet();

const sources = new Map();    // screen path -> Promise<html>
const components = new Map(); // component name -> Promise<html>

const escScreen = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function fetchText(path) {
  const bundle = window.__MOCKERY_BUNDLE__;
  if (bundle?.files) {
    const key = String(path || '').replace(/^\/+/, '');
    if (Object.prototype.hasOwnProperty.call(bundle.files, key)) return bundle.files[key];
    throw new Error(`404 ${key}`);
  }
  const res = await fetch(`/${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.text();
}

function cached(map, key, path) {
  if (!map.has(key)) map.set(key, fetchText(path));
  return map.get(key);
}

export const isSharedStyle = (path) => STYLE_FILES.includes(path);

export async function loadSharedStyles() {
  const parts = await Promise.all(STYLE_FILES.map((f) => fetchText(f).catch(() => '')));
  // Adopted sheets cascade after a screen's own <style>; a layer lets screen styles win instead.
  sharedSheet.replaceSync(`@layer shared {\n${parts.join('\n')}\n}`);
}

// Forget a cached file. Returns the component name for components/*.html paths.
export function invalidate(path) {
  if (path === '*') { sources.clear(); components.clear(); return; }
  const m = path.match(/^components\/(.+)\.html$/);
  if (m) { components.delete(m[1]); return m[1]; }
  sources.delete(path);
}

// {{name}} -> attribute value (escaped), {{name|fallback}} -> fallback if missing, {{slot}} -> inner HTML.
function fill(template, el) {
  return template.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback = '') =>
    key === 'slot' ? el.innerHTML || fallback : el.hasAttribute(key) ? escScreen(el.getAttribute(key)) : fallback);
}

// Replace top-level <x-include src="name"> with components/name.html, then repeat for nested includes.
async function expand(html, deps, depth = 0) {
  if (!html.includes('<x-include') || depth > 8) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const includes = [...tpl.content.querySelectorAll('x-include')].filter((el) => !el.parentElement?.closest('x-include'));
  await Promise.all(includes.map(async (el) => {
    const name = el.getAttribute('src');
    deps.add(name);
    let part;
    try { part = await cached(components, name, `components/${name}.html`); }
    catch { part = `<div style="padding:8px;border:2px dashed #d33;color:#d33;font:12px monospace">Missing component: ${escScreen(name)}</div>`; }
    const out = document.createElement('template');
    out.innerHTML = fill(part, el);
    el.replaceWith(out.content);
  }));
  return expand(tpl.innerHTML, deps, depth + 1);
}

function lint(file, html) {
  const rules = [
    [/<script\b/i, 'contains <script> (stripped; screens must be static)'],
    [/position\s*:\s*fixed/i, 'uses position:fixed'],
    [/\d(vw|vh|vmin|vmax|dvh|svh|lvh)\b/i, 'uses viewport units'],
    [/@media\b/i, 'uses @media (screens are fixed-size)'],
  ];
  for (const [re, msg] of rules) if (re.test(html)) console.warn(`[mockery] ${file} ${msg}`);
}

// Returns the fully expanded HTML for a screen plus the set of components it used.
export async function renderScreen(file) {
  const deps = new Set();
  const html = await expand(await cached(sources, file, file), deps);
  lint(file, html);
  return { html: html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ''), deps };
}
