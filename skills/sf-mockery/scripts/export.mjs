// Standalone single-file HTML exporter for Mockery projects.
// Compiles flow.json, tokens.css, kit.css, optional fonts.css, components/*.html,
// screens/*.html, local assets/*, and the Mockery viewer into one self-contained HTML file
// that opens directly via file:// with zero server, Node, or network required.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME_TYPES, deriveProjectName } from './server.mjs';
import { safeResolve } from './check.mjs';

const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(SCRIPTS_ROOT, 'viewer');

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const escStyle = (css) => String(css).replace(/<\/style/gi, '<\\/style');
const escScriptJson = (obj) => JSON.stringify(obj).replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const toPosix = (p) => p.split(path.sep).join('/');

function collectAssets(absRoot) {
  const assetsDir = path.join(absRoot, 'assets');
  const dataUriMap = new Map();
  if (!fs.existsSync(assetsDir)) return dataUriMap;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = toPosix(path.relative(absRoot, full));
        const mime = MIME_TYPES[path.extname(entry.name).toLowerCase()] || 'application/octet-stream';
        const b64 = fs.readFileSync(full).toString('base64');
        dataUriMap.set(rel, `data:${mime};base64,${b64}`);
      }
    }
  };
  walk(assetsDir);
  return dataUriMap;
}

function inlineAssetRefs(text, assetMap) {
  if (!text || assetMap.size === 0) return text;
  // Match /assets/... or assets/... inside HTML attributes or CSS url(...)
  return text.replace(/(?:\/|\.?\/)?(assets\/[^\s"'()<>]+)/g, (match, rel) => {
    const clean = rel.split(/[?#]/)[0];
    return assetMap.has(clean) ? assetMap.get(clean) : match;
  });
}

function collectHtmlDir(absRoot, subdir, assetMap) {
  const dir = path.join(absRoot, subdir);
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.html')) {
        const rel = toPosix(path.relative(absRoot, full));
        out[rel] = inlineAssetRefs(fs.readFileSync(full, 'utf8'), assetMap);
      }
    }
  };
  walk(dir);
  return out;
}

function stripModuleSyntax(src) {
  return src
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '');
}

function buildInlineViewerScript() {
  const cameraSrc = stripModuleSyntax(fs.readFileSync(path.join(VIEWER_DIR, 'camera.js'), 'utf8'));
  const screensSrc = stripModuleSyntax(fs.readFileSync(path.join(VIEWER_DIR, 'screens.js'), 'utf8'));
  const edgesSrc = stripModuleSyntax(fs.readFileSync(path.join(VIEWER_DIR, 'edges.js'), 'utf8'));
  const rendererSrc = stripModuleSyntax(fs.readFileSync(path.join(VIEWER_DIR, 'renderer.js'), 'utf8'));
  const mainSrc = stripModuleSyntax(fs.readFileSync(path.join(VIEWER_DIR, 'main.js'), 'utf8'));

  return [
    '(function() {',
    '  "use strict";',
    '  const { createCamera } = (function() {',
    cameraSrc,
    '    return { createCamera };',
    '  })();',
    '  const { sharedSheet, isSharedStyle, loadSharedStyles, invalidate, renderScreen } = (function() {',
    screensSrc,
    '    return { sharedSheet, isSharedStyle, loadSharedStyles, invalidate, renderScreen };',
    '  })();',
    '  const { anchorSelector, drawEdges } = (function() {',
    edgesSrc,
    '    return { anchorSelector, drawEdges };',
    '  })();',
    '  const renderer = (function() {',
    rendererSrc,
    '    return { LOD_SCALE, frames, setFlow, rerender, remeasure, setCamera, select, selected, focusRect, bounds };',
    '  })();',
    '  (async function() {',
    mainSrc,
    '  })().catch(function(err) {',
    '    var t = document.getElementById("toast");',
    '    if (t) t.textContent = "Viewer error: " + (err && err.message ? err.message : String(err));',
    '  });',
    '})();',
  ].join('\n');
}

export function exportProject(root, { outFile, title } = {}) {
  const absRoot = path.resolve(root);
  const flowPath = path.join(absRoot, 'flow.json');
  if (!fs.existsSync(flowPath)) {
    throw new Error(`no flow.json in ${absRoot}`);
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  } catch (err) {
    throw new Error(`invalid flow.json: ${err.message}`);
  }

  const assetMap = collectAssets(absRoot);
  const files = {};

  for (const styleFile of ['tokens.css', 'kit.css']) {
    const p = path.join(absRoot, styleFile);
    if (fs.existsSync(p)) {
      files[styleFile] = inlineAssetRefs(fs.readFileSync(p, 'utf8'), assetMap);
    }
  }

  const components = collectHtmlDir(absRoot, 'components', assetMap);
  Object.assign(files, components);

  const screens = collectHtmlDir(absRoot, 'screens', assetMap);
  Object.assign(files, screens);

  // Also ensure any node.file outside screens/ (still inside project root) is included.
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  let screenCount = Object.keys(screens).length;
  for (const n of nodes) {
    if (!n?.id) continue;
    const rel = n.file ? String(n.file).replace(/^\.?\//, '') : `screens/${n.id}.html`;
    if (files[rel]) continue;
    const resolved = safeResolve(absRoot, rel);
    if (resolved && fs.existsSync(resolved.full)) {
      files[resolved.clean] = inlineAssetRefs(fs.readFileSync(resolved.full, 'utf8'), assetMap);
      screenCount++;
    }
  }

  const fontsPath = path.join(absRoot, 'fonts.css');
  const fontsCss = fs.existsSync(fontsPath)
    ? inlineAssetRefs(fs.readFileSync(fontsPath, 'utf8'), assetMap)
    : '';

  const viewerCss = fs.readFileSync(path.join(VIEWER_DIR, 'viewer.css'), 'utf8');
  const viewerScript = buildInlineViewerScript();
  const projectName = title || flow.title || deriveProjectName(absRoot);
  const projectId = `standalone:${projectName}`;

  const bundlePayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    projectName,
    flow,
    files,
  };

  const html = [
    '<!doctype html>',
    `<html lang="en" data-project="${escAttr(projectId)}">`,
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${escAttr(projectName)} · Mockery Preview</title>`,
    `  <style>\n${escStyle(viewerCss)}\n  </style>`,
    fontsCss ? `  <style>\n${escStyle(fontsCss)}\n  </style>` : '',
    '</head>',
    '<body>',
    '  <div id="viewport">',
    '    <div id="world">',
    '      <div id="sections"></div>',
    '      <div id="frames"></div>',
    '      <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>',
    '      <div id="labels">',
    '        <div id="section-titles"></div>',
    '        <div id="frame-titles"></div>',
    '        <div id="edge-labels"></div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '',
    '  <div id="hud">',
    '    <span id="status" title="Standalone exported preview"></span>',
    '    <b id="zoom">100%</b>',
    '    <span class="hints"><kbd>0</kbd> fit <kbd>+</kbd><kbd>−</kbd> zoom <kbd>1</kbd> 100% <kbd>T</kbd> theme</span>',
    '    <span id="flash"></span>',
    '  </div>',
    '  <div id="toast"></div>',
    `  <script>window.__MOCKERY_BUNDLE__ = ${escScriptJson(bundlePayload)};</script>`,
    `  <script>\n${viewerScript.replace(/<\/script/gi, '<\\/script')}\n  </script>`,
    '</body>',
    '</html>',
    '',
  ].filter((line, idx, arr) => !(line === '' && arr[idx - 1] === '')).join('\n');

  const targetOut = path.resolve(outFile || path.join(absRoot, 'preview.html'));
  fs.mkdirSync(path.dirname(targetOut), { recursive: true });
  fs.writeFileSync(targetOut, html, 'utf8');

  return {
    ok: true,
    root: absRoot,
    outFile: targetOut,
    bytes: Buffer.byteLength(html, 'utf8'),
    projectName,
    summary: {
      nodes: nodes.length,
      edges: Array.isArray(flow.edges) ? flow.edges.length : 0,
      screens: screenCount,
      components: Object.keys(components).length,
      assets: assetMap.size,
    },
  };
}
