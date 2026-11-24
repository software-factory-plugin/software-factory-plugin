// Headless validator for a Mockery project folder. Zero dependencies (Node 20+ built-ins only).
import fs from 'node:fs';
import path from 'node:path';

export const VALID_DEVICES = new Set(['phone', 'tablet', 'pos', 'desktop', 'none']);
export const VALID_EDGE_STYLES = new Set(['dashed', 'error', 'success', 'muted']);
export const LINT_RULES = [
  [/<script\b/i, 'contains <script> (stripped; screens must be static)'],
  [/position\s*:\s*fixed/i, 'uses position:fixed'],
  [/\d(vw|vh|vmin|vmax|dvh|svh|lvh)\b/i, 'uses viewport units'],
  [/@media\b/i, 'uses @media (screens are fixed-size)'],
];

export function safeResolve(root, rel) {
  const clean = String(rel || '').replace(/^\.?\//, '');
  const full = path.resolve(root, clean);
  const base = path.resolve(root) + path.sep;
  if (!full.startsWith(base)) return null;
  return { clean, full };
}

export function parseAttrs(tagAttrs) {
  const attrs = new Map();
  const re = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(tagAttrs)) !== null) {
    attrs.set(m[1], m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// Expand <x-include src="..."> tags statically (up to depth 8) so lints and data-goto checks see the full screen.
export function expandIncludes(root, html, ownerFile, errors, usedComponents, depth = 0) {
  if (!html.includes('<x-include')) return html;
  if (depth > 8) {
    errors.push({ file: ownerFile, code: 'include-depth', message: '<x-include> nesting exceeded max depth (8)' });
    return html;
  }

  let changed = false;
  const out = html.replace(/<x-include\b([^>]*)(?:\/>|>([\s\S]*?)<\/x-include>)/gi, (_full, rawAttrs, slot = '') => {
    changed = true;
    const attrs = parseAttrs(rawAttrs);
    const src = attrs.get('src');
    if (!src) {
      errors.push({ file: ownerFile, code: 'missing-include-src', message: '<x-include> missing required src attribute' });
      return '';
    }
    const rel = `components/${src}.html`;
    const resolved = safeResolve(root, rel);
    if (!resolved || !fs.existsSync(resolved.full)) {
      errors.push({ file: ownerFile, code: 'missing-component', message: `missing component: ${rel}` });
      return '';
    }
    usedComponents.add(src);
    const partial = fs.readFileSync(resolved.full, 'utf8');
    const filled = partial.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback = '') =>
      key === 'slot' ? (slot || fallback) : (attrs.has(key) ? attrs.get(key) : fallback),
    );
    return expandIncludes(root, filled, rel, errors, usedComponents, depth + 1);
  });

  return changed && out.includes('<x-include')
    ? expandIncludes(root, out, ownerFile, errors, usedComponents, depth + 1)
    : out;
}

export function checkProject(root) {
  const absRoot = path.resolve(root);
  const errors = [];
  const warnings = [];
  const usedComponents = new Set();

  const flowPath = path.join(absRoot, 'flow.json');
  if (!fs.existsSync(flowPath)) {
    errors.push({ file: 'flow.json', code: 'missing-flow', message: `no flow.json in ${absRoot}` });
    return { ok: false, root: absRoot, summary: { sections: 0, nodes: 0, edges: 0, components: 0 }, errors, warnings };
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  } catch (err) {
    errors.push({ file: 'flow.json', code: 'invalid-json', message: `invalid JSON: ${err.message}` });
    return { ok: false, root: absRoot, summary: { sections: 0, nodes: 0, edges: 0, components: 0 }, errors, warnings };
  }

  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes)) {
    errors.push({ file: 'flow.json', code: 'invalid-schema', message: 'flow.json must contain a "nodes" array' });
    return { ok: false, root: absRoot, summary: { sections: 0, nodes: 0, edges: 0, components: 0 }, errors, warnings };
  }

  const sections = Array.isArray(flow.sections) ? flow.sections : [];
  const nodes = flow.nodes;
  const edges = Array.isArray(flow.edges) ? flow.edges : [];

  if (!fs.existsSync(path.join(absRoot, 'tokens.css'))) {
    warnings.push({ file: 'tokens.css', code: 'missing-tokens', message: 'tokens.css not found' });
  }
  if (!fs.existsSync(path.join(absRoot, 'kit.css'))) {
    warnings.push({ file: 'kit.css', code: 'missing-kit', message: 'kit.css not found' });
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
    if (n.w === undefined || n.h === undefined) {
      warnings.push({ file: 'flow.json', code: 'implicit-dimensions', message: `node "${n.id}" should specify explicit numeric w and h` });
    } else if (!Number.isFinite(n.w) || !Number.isFinite(n.h) || n.w <= 0 || n.h <= 0) {
      errors.push({ file: 'flow.json', code: 'invalid-dimensions', message: `node "${n.id}" has invalid w/h (${n.w}x${n.h})` });
    }
    if (n.section && sections.length > 0 && !sectionIds.has(n.section)) {
      errors.push({ file: 'flow.json', code: 'missing-section', message: `node "${n.id}" references undeclared section "${n.section}"` });
    }

    const relFile = n.file ? String(n.file).replace(/^\.?\//, '') : `screens/${n.id}.html`;
    const resolved = safeResolve(absRoot, relFile);
    if (!resolved) {
      errors.push({ file: 'flow.json', code: 'invalid-file-path', message: `node "${n.id}" file escapes project root: ${relFile}` });
      continue;
    }
    if (!fs.existsSync(resolved.full)) {
      errors.push({ file: resolved.clean, code: 'missing-screen', message: `node "${n.id}" screen file not found: ${resolved.clean}` });
      continue;
    }

    const rawHtml = fs.readFileSync(resolved.full, 'utf8');
    const expanded = expandIncludes(absRoot, rawHtml, resolved.clean, errors, usedComponents, 0);
    expandedByNode.set(n.id, expanded);

    for (const [re, msg] of LINT_RULES) {
      if (re.test(expanded)) {
        errors.push({ file: resolved.clean, code: 'screen-lint', message: `${resolved.clean} ${msg}` });
      }
    }
  }

  for (const name of usedComponents) {
    const compRel = `components/${name}.html`;
    const compPath = path.join(absRoot, compRel);
    if (fs.existsSync(compPath)) {
      const compHtml = fs.readFileSync(compPath, 'utf8');
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
      const srcHtml = expandedByNode.get(e.from) || '';
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
