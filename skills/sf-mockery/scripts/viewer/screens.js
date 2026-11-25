// Screens: fetch screen + component files (or read from an embedded standalone bundle),
// expand <x-include>, sanitize HTML fragments, and own the shared stylesheet adopted by every shadow root.

const STYLE_FILES = ['tokens.css', 'kit.css'];
const DISALLOWED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'foreignobject',
]);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster']);

export const sharedSheet = new CSSStyleSheet();

const sources = new Map();    // screen path -> Promise<html>
const components = new Map(); // component name -> Promise<html>

const escScreen = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });

function isSafeUrl(value) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
    return false;
  }
  if (normalized.startsWith('data:')) {
    return normalized.startsWith('data:image/') || normalized.startsWith('data:font/');
  }
  return true;
}

function sanitizeNodeTree(root) {
  const elements = [...root.querySelectorAll('*')];
  for (const el of elements) {
    if (!root.contains(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (DISALLOWED_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (tag === 'template' && el.content) {
      sanitizeNodeTree(el.content);
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

export function sanitizeHtmlFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  sanitizeNodeTree(tpl.content);
  return tpl.innerHTML;
}

function makeErrorCard(message) {
  const div = document.createElement('div');
  div.style.cssText = 'padding:8px;border:2px dashed #d33;color:#d33;font:12px monospace';
  div.textContent = message;
  return div;
}

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
  if (!map.has(key)) {
    const p = fetchText(path);
    p.catch(() => {
      if (map.get(key) === p) map.delete(key);
    });
    map.set(key, p);
  }
  return map.get(key);
}

export const isSharedStyle = (path) => STYLE_FILES.includes(path);

export async function loadSharedStyles() {
  const parts = await Promise.all(STYLE_FILES.map((f) => fetchText(f).catch(() => '')));
  const cleaned = parts.map((css) => css.replace(/^\s*@charset\s+[^;]+;\s*/gim, ''));
  // Adopted sheets cascade after a screen's own <style>; a layer lets screen styles win instead.
  sharedSheet.replaceSync(`@layer shared {\n${cleaned.join('\n')}\n}`);
}

// Forget a cached file. Returns the component name for components/*.html paths.
export function invalidate(path) {
  if (path === '*') { sources.clear(); components.clear(); return; }
  const m = path.match(/^components\/(.+)\.html$/);
  if (m) { components.delete(m[1]); return m[1]; }
  sources.delete(path);
}

// {{name}} -> attribute value (escaped), {{name|fallback}} -> escaped fallback if missing, {{slot}} -> inner HTML.
function fill(template, el) {
  return template.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback = '') =>
    key === 'slot'
      ? (el.innerHTML || fallback)
      : (el.hasAttribute(key) ? escScreen(el.getAttribute(key)) : escScreen(fallback)),
  );
}

// Replace top-level <x-include src="name"> with components/name.html, with cycle detection and nested expansion.
async function expand(html, deps, depth = 0, includeStack = new Set()) {
  if (!/<x-include\b/i.test(html) || depth > 8) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const includes = [...tpl.content.querySelectorAll('x-include')].filter((el) => !el.parentElement?.closest('x-include'));
  if (includes.length === 0) return html;
  await Promise.all(includes.map(async (el) => {
    const name = el.getAttribute('src');
    if (!name) {
      el.replaceWith(makeErrorCard('Missing component: (no src)'));
      return;
    }
    if (includeStack.has(name)) {
      const chain = [...includeStack, name].join(' -> ');
      el.replaceWith(makeErrorCard(`Include cycle detected: ${chain}`));
      return;
    }
    deps.add(name);
    let part;
    try {
      part = await cached(components, name, `components/${name}.html`);
    } catch {
      el.replaceWith(makeErrorCard(`Missing component: ${name}`));
      return;
    }
    const nextStack = new Set(includeStack);
    nextStack.add(name);
    const expandedChild = await expand(fill(part, el), deps, depth + 1, nextStack);
    const out = document.createElement('template');
    out.innerHTML = expandedChild;
    el.replaceWith(out.content);
  }));
  return tpl.innerHTML;
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

// Returns the fully expanded, sanitized HTML for a screen plus the set of components it used.
export async function renderScreen(file) {
  const deps = new Set();
  const expanded = await expand(await cached(sources, file, file), deps, 0, new Set());
  lint(file, expanded);
  return { html: sanitizeHtmlFragment(expanded), deps };
}
