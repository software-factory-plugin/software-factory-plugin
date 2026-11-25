// Headless validator for a Mockery project folder. Zero dependencies (Node 22+ built-ins only).
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, resolveContainedPath } from '../../../lib/fs-safe.mjs';
import { toPosixPath } from '../../../lib/cli-utils.mjs';

export const VALID_DEVICES = new Set(['phone', 'tablet', 'pos', 'desktop', 'none']);
export const VALID_EDGE_STYLES = new Set(['dashed', 'error', 'success', 'muted']);

const HTML_LINT_RULES = [
  [/<script\b/i, 'contains <script> (stripped; screens must be static)'],
];
const CSS_LINT_RULES = [
  [/position\s*:\s*fixed/i, 'uses position:fixed'],
  [/\d(vw|vh|vmin|vmax|dvh|svh|lvh)\b/i, 'uses viewport units'],
  [/@media\b/i, 'uses @media (screens are fixed-size)'],
];
export const LINT_RULES = [...HTML_LINT_RULES, ...CSS_LINT_RULES];

const stripHtmlComments = (html) => String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
const stripCssComments = (css) => String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

function extractScreenCss(htmlNoComments) {
  const chunks = [];
  for (const m of htmlNoComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    chunks.push(m[1]);
  }
  for (const m of htmlNoComments.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    chunks.push(m[1] ?? m[2] ?? '');
  }
  return stripCssComments(chunks.join('\n'));
}

function collectLocalAssetRefs(text, isCss = false) {
  const refs = new Set();
  if (!text) return refs;

  const normalize = (rawRel) => rawRel.replace(/^(?:(?:\.\.\/)+|\.\/|\/)/, '').split(/[?#]/)[0];

  for (const m of text.matchAll(
    /url\(\s*(["']?)((?:(?:\.\.\/)+|\.\/|\/)?assets\/[^"'()\s<>#?]+)(?:[?#][^"'()\s<>]*)?\1\s*\)/gi,
  )) {
    const clean = normalize(m[2]);
    if (clean) refs.add(clean);
  }

  if (!isCss) {
    for (const m of text.matchAll(
      /(?:=\s*)(["'])((?:(?:\.\.\/)+|\.\/|\/)?assets\/[^"'<>#?\s]+)(?:[?#][^"'<>\s]*)?\1/gi,
    )) {
      const clean = normalize(m[2]);
      if (clean) refs.add(clean);
    }
  }

  return refs;
}

export function safeResolve(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const absRoot = path.resolve(root);
  const trimmed = rel.replace(/^\.?\//, '');
  const res = resolveContainedPath(absRoot, trimmed, {
    allowBase: false,
    allowSymlinks: false,
    requireFile: false,
  });
  if (res.ok) {
    return { clean: res.clean, full: res.realPath };
  }
  if (res.reason === 'not_found') {
    const absTarget = path.resolve(absRoot, trimmed.replace(/^\/+/, ''));
    if (!isPathInside(absRoot, absTarget) || absTarget === absRoot) return null;
    const clean = toPosixPath(path.relative(absRoot, absTarget));
    return { clean, full: absTarget };
  }
  return null;
}

export function parseAttrs(tagAttrs) {
  const attrs = new Map();
  const re = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(tagAttrs)) !== null) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// Find the closing '>' of an HTML start tag starting after '<tagname', respecting quoted attributes.
function findTagEnd(html, startIdx) {
  let quote = null;
  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

// Find the next <x-include ...> start tag outside HTML comments.
function findNextIncludeOpen(html, fromIdx) {
  let i = fromIdx;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return -1;
    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) return -1;
      i = endComment + 3;
      continue;
    }
    const slice = html.slice(lt, lt + 11).toLowerCase();
    if (slice.startsWith('<x-include')) {
      const nextCh = html[lt + 10];
      if (!nextCh || /[\s/>]/.test(nextCh)) {
        return lt;
      }
    }
    i = lt + 1;
  }
  return -1;
}

// Find the matching </x-include> close tag for an already-opened <x-include>, accounting for nested <x-include>.
function findMatchingIncludeClose(html, startIdx) {
  let nesting = 1;
  let i = startIdx;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return null;
    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) return null;
      i = endComment + 3;
      continue;
    }
    const lower = html.slice(lt, lt + 13).toLowerCase();
    if (lower.startsWith('<x-include')) {
      const nextCh = html[lt + 10];
      if (!nextCh || /[\s/>]/.test(nextCh)) {
        const gt = findTagEnd(html, lt + 10);
        if (gt === -1) return null;
        const innerAttrs = html.slice(lt + 10, gt).trimEnd();
        if (!innerAttrs.endsWith('/')) {
          nesting++;
        }
        i = gt + 1;
        continue;
      }
    } else if (lower.startsWith('</x-include')) {
      const nextCh = html[lt + 11];
      if (nextCh && /[\s>]/.test(nextCh)) {
        const gt = html.indexOf('>', lt + 11);
        if (gt === -1) return null;
        nesting--;
        if (nesting === 0) {
          return { closeStart: lt, closeEnd: gt + 1 };
        }
        i = gt + 1;
        continue;
      }
    }
    i = lt + 1;
  }
  return null;
}

// Expand <x-include src="..."> tags statically (up to depth 8) with balanced tag scanning and cycle detection.
export function expandIncludes(root, html, ownerFile, errors, usedComponents, depth = 0, includeStack = new Set()) {
  if (!/<x-include(?=[\s/>])/i.test(html)) return html;
  if (depth > 8) {
    errors.push({ file: ownerFile, code: 'include-depth', message: '<x-include> nesting exceeded max depth (8)' });
    return html;
  }

  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    const openStart = findNextIncludeOpen(html, cursor);
    if (openStart === -1) {
      out += html.slice(cursor);
      break;
    }

    out += html.slice(cursor, openStart);
    const gt = findTagEnd(html, openStart + 10);
    if (gt === -1) {
      out += html.slice(openStart);
      break;
    }

    const rawAttrs = html.slice(openStart + 10, gt);
    const trimmedAttrs = rawAttrs.trimEnd();
    if (trimmedAttrs.endsWith('/')) {
      errors.push({
        file: ownerFile,
        code: 'self-closing-include',
        message: 'self-closing <x-include ... /> is invalid in HTML5; use <x-include ...></x-include>',
      });
      cursor = gt + 1;
      continue;
    }

    const closeMatch = findMatchingIncludeClose(html, gt + 1);
    if (!closeMatch) {
      errors.push({
        file: ownerFile,
        code: 'unclosed-include',
        message: 'unclosed <x-include> tag (missing </x-include>)',
      });
      out += html.slice(openStart);
      break;
    }

    const slot = html.slice(gt + 1, closeMatch.closeStart);
    cursor = closeMatch.closeEnd;

    const attrs = parseAttrs(rawAttrs);
    const src = attrs.get('src');
    if (!src) {
      errors.push({ file: ownerFile, code: 'missing-include-src', message: '<x-include> missing required src attribute' });
      continue;
    }

    if (includeStack.has(src)) {
      const chain = [...includeStack, src].join(' -> ');
      errors.push({
        file: ownerFile,
        code: 'include-cycle',
        message: `cyclic <x-include> detected: ${chain}`,
      });
      continue;
    }

    const rel = `components/${src}.html`;
    const resolved = safeResolve(root, rel);
    if (!resolved) {
      errors.push({ file: ownerFile, code: 'invalid-file-path', message: `component path is not allowed: ${rel}` });
      continue;
    }
    if (!fs.existsSync(resolved.full) || !fs.statSync(resolved.full).isFile()) {
      errors.push({ file: ownerFile, code: 'missing-component', message: `missing component: ${rel}` });
      continue;
    }

    usedComponents.add(src);
    const partial = fs.readFileSync(resolved.full, 'utf8');
    const filled = partial.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback = '') => {
      const lowerKey = key.toLowerCase();
      return lowerKey === 'slot' ? (slot || fallback) : (attrs.has(lowerKey) ? attrs.get(lowerKey) : fallback);
    });

    const nextStack = new Set(includeStack);
    nextStack.add(src);
    out += expandIncludes(root, filled, rel, errors, usedComponents, depth + 1, nextStack);
  }

  return out;
}

export function checkProject(root) {
  const absRoot = path.resolve(root);
  const errors = [];
  const warnings = [];
  const usedComponents = new Set();

  const flowResolved = resolveContainedPath(absRoot, 'flow.json', {
    allowSymlinks: false,
    requireFile: true,
  });
  if (!flowResolved.ok) {
    errors.push({ file: 'flow.json', code: 'missing-flow', message: `no flow.json in ${absRoot}` });
    return { ok: false, root: absRoot, summary: { sections: 0, nodes: 0, edges: 0, components: 0 }, errors, warnings };
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowResolved.realPath, 'utf8'));
  } catch (err) {
    errors.push({ file: 'flow.json', code: 'invalid-json', message: `invalid JSON: ${err.message}` });
    return { ok: false, root: absRoot, summary: { sections: 0, nodes: 0, edges: 0, components: 0 }, errors, warnings };
  }

  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes)) {
    errors.push({ file: 'flow.json', code: 'invalid-schema', message: 'flow.json must contain a "nodes" array' });
    return { ok: false, root: absRoot, summary: { sections: 0, nodes: 0, edges: 0, components: 0 }, errors, warnings };
  }

  if (flow.sections !== undefined && !Array.isArray(flow.sections)) {
    errors.push({ file: 'flow.json', code: 'invalid-schema', message: 'flow.json "sections" must be an array when present' });
  }
  if (flow.edges !== undefined && !Array.isArray(flow.edges)) {
    errors.push({ file: 'flow.json', code: 'invalid-schema', message: 'flow.json "edges" must be an array when present' });
  }

  const sections = Array.isArray(flow.sections) ? flow.sections : [];
  const nodes = flow.nodes;
  const edges = Array.isArray(flow.edges) ? flow.edges : [];

  const checkMissingAssets = (ownerFile, text, isCss) => {
    for (const assetRel of collectLocalAssetRefs(text, isCss)) {
      const assetResolved = safeResolve(absRoot, assetRel);
      if (!assetResolved || !fs.existsSync(assetResolved.full) || !fs.statSync(assetResolved.full).isFile()) {
        warnings.push({
          file: ownerFile,
          code: 'missing-asset',
          message: `referenced local asset not found: ${assetRel}`,
        });
      }
    }
  };

  for (const [styleFile, missingCode] of [['tokens.css', 'missing-tokens'], ['kit.css', 'missing-kit']]) {
    const styleResolved = resolveContainedPath(absRoot, styleFile, {
      allowSymlinks: false,
      requireFile: true,
    });
    if (!styleResolved.ok) {
      warnings.push({ file: styleFile, code: missingCode, message: `${styleFile} not found` });
      continue;
    }
    const cssNoComments = stripCssComments(fs.readFileSync(styleResolved.realPath, 'utf8'));
    if (/@import\b/i.test(cssNoComments)) {
      warnings.push({
        file: styleFile,
        code: 'css-import-in-layer',
        message: `${styleFile} uses @import (ignored inside @layer shared; move @import to fonts.css)`,
      });
    }
    for (const [re, msg] of CSS_LINT_RULES) {
      if (re.test(cssNoComments)) {
        errors.push({ file: styleFile, code: 'screen-lint', message: `${styleFile} ${msg}` });
      }
    }
    checkMissingAssets(styleFile, cssNoComments, true);
  }

  const sectionIds = new Set();
  for (const s of sections) {
    if (!s?.id) {
      errors.push({ file: 'flow.json', code: 'missing-section-id', message: 'section is missing required "id"' });
      continue;
    }
    if (sectionIds.has(s.id)) {
      errors.push({ file: 'flow.json', code: 'duplicate-section-id', message: `duplicate section id "${s.id}"` });
    }
    sectionIds.add(s.id);
  }

  const nodeIds = new Set();
  const expandedByNode = new Map();
  const fileByNode = new Map();

  for (const n of nodes) {
    if (!n?.id || typeof n.id !== 'string') {
      errors.push({ file: 'flow.json', code: 'missing-node-id', message: 'node is missing required string "id"' });
      continue;
    }
    if (nodeIds.has(n.id)) {
      errors.push({ file: 'flow.json', code: 'duplicate-node-id', message: `duplicate node id "${n.id}"` });
    }
    nodeIds.add(n.id);

    if (n.device !== undefined && !VALID_DEVICES.has(n.device)) {
      errors.push({ file: 'flow.json', code: 'invalid-device', message: `node "${n.id}" has unknown device "${n.device}"` });
    }
    if (
      (n.x !== undefined && (typeof n.x !== 'number' || !Number.isFinite(n.x))) ||
      (n.y !== undefined && (typeof n.y !== 'number' || !Number.isFinite(n.y)))
    ) {
      errors.push({ file: 'flow.json', code: 'invalid-coordinates', message: `node "${n.id}" has invalid x/y (${n.x}, ${n.y})` });
    }
    if (n.w === undefined || n.h === undefined) {
      warnings.push({ file: 'flow.json', code: 'implicit-dimensions', message: `node "${n.id}" should specify explicit numeric w and h` });
    } else if (!Number.isFinite(n.w) || !Number.isFinite(n.h) || n.w <= 0 || n.h <= 0) {
      errors.push({ file: 'flow.json', code: 'invalid-dimensions', message: `node "${n.id}" has invalid w/h (${n.w}x${n.h})` });
    }
    if (n.section && !sectionIds.has(n.section)) {
      errors.push({ file: 'flow.json', code: 'missing-section', message: `node "${n.id}" references undeclared section "${n.section}"` });
    }

    const relFile = n.file ? String(n.file).replace(/^\.?\//, '') : `screens/${n.id}.html`;
    const resolved = safeResolve(absRoot, relFile);
    if (!resolved) {
      errors.push({ file: 'flow.json', code: 'invalid-file-path', message: `node "${n.id}" file escapes project root: ${relFile}` });
      continue;
    }
    if (!fs.existsSync(resolved.full) || !fs.statSync(resolved.full).isFile()) {
      errors.push({ file: resolved.clean, code: 'missing-screen', message: `node "${n.id}" screen file not found: ${resolved.clean}` });
      continue;
    }

    const rawHtml = fs.readFileSync(resolved.full, 'utf8');
    const expanded = expandIncludes(absRoot, rawHtml, resolved.clean, errors, usedComponents, 0, new Set());
    expandedByNode.set(n.id, expanded);
    fileByNode.set(n.id, resolved.clean);

    const htmlNoComments = stripHtmlComments(expanded);
    for (const [re, msg] of HTML_LINT_RULES) {
      if (re.test(htmlNoComments)) {
        errors.push({ file: resolved.clean, code: 'screen-lint', message: `${resolved.clean} ${msg}` });
      }
    }
    const screenCss = extractScreenCss(htmlNoComments);
    for (const [re, msg] of CSS_LINT_RULES) {
      if (re.test(screenCss)) {
        errors.push({ file: resolved.clean, code: 'screen-lint', message: `${resolved.clean} ${msg}` });
      }
    }
    checkMissingAssets(resolved.clean, htmlNoComments, false);
  }

  // Reverse data-goto check: warn if a screen's data-goto points to a nonexistent node.
  for (const [nodeId, expanded] of expandedByNode) {
    const htmlNoComments = stripHtmlComments(expanded);
    const ownerFile = fileByNode.get(nodeId) || `screens/${nodeId}.html`;
    for (const m of htmlNoComments.matchAll(/\bdata-goto\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const targetId = m[1] ?? m[2] ?? '';
      if (!targetId || !nodeIds.has(targetId)) {
        warnings.push({
          file: ownerFile,
          code: 'dangling-goto',
          message: `screen "${nodeId}" has data-goto="${targetId}" pointing to nonexistent node`,
        });
      }
    }
  }

  for (const name of usedComponents) {
    const compRel = `components/${name}.html`;
    const compResolved = safeResolve(absRoot, compRel);
    if (compResolved && fs.existsSync(compResolved.full) && fs.statSync(compResolved.full).isFile()) {
      const compHtml = stripHtmlComments(fs.readFileSync(compResolved.full, 'utf8'));
      if (/<style\b/i.test(compHtml)) {
        warnings.push({ file: compRel, code: 'component-style', message: `${compRel} contains <style> (component styles belong in kit.css)` });
      }
    }
  }

  for (const e of edges) {
    if (!e?.from || !e?.to) {
      errors.push({ file: 'flow.json', code: 'invalid-edge', message: 'edge is missing required "from" or "to"' });
      continue;
    }
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
      errors.push({ file: 'flow.json', code: 'missing-edge-node', message: `edge ${e.from} -> ${e.to} references a missing node` });
      continue;
    }
    const styles = (e.style || '').split(/\s+/).filter(Boolean);
    for (const st of styles) {
      if (!VALID_EDGE_STYLES.has(st)) {
        warnings.push({ file: 'flow.json', code: 'unknown-edge-style', message: `edge ${e.from} -> ${e.to} uses unknown style "${st}"` });
      }
    }
    const isDashed = styles.includes('dashed');
    if (!isDashed && !e.fromSelector) {
      const srcHtml = stripHtmlComments(expandedByNode.get(e.from) || '');
      const escapedTarget = e.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const gotoRe = new RegExp(`data-goto\\s*=\\s*["']${escapedTarget}["']`);
      if (!gotoRe.test(srcHtml)) {
        warnings.push({
          file: 'flow.json',
          code: 'unanchored-edge',
          message: `edge ${e.from} -> ${e.to} has no matching data-goto="${e.to}" in source screen (add data-goto, fromSelector, or style:"dashed")`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    root: absRoot,
    summary: {
      sections: sections.length,
      nodes: nodes.length,
      edges: edges.length,
      components: usedComponents.size,
    },
    errors,
    warnings,
  };
}
