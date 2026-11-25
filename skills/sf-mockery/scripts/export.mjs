// Standalone single-file HTML exporter for Mockery projects.
// Compiles flow.json, tokens.css, kit.css, optional fonts.css, components/*.html,
// screens/*.html, local assets/*, and the Mockery viewer into one self-contained HTML file
// that opens directly via file:// with zero server, Node, or network required.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escHtml, toPosixPath } from '../../../lib/cli-utils.mjs';
import { isPathInside, resolveContainedPath } from '../../../lib/fs-safe.mjs';
import { MIME_TYPES, deriveProjectName } from './server.mjs';

const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(SCRIPTS_ROOT, 'viewer');

const escStyle = (css) => String(css).replace(/<\/style/gi, '<\\/style');
const escScriptJson = (obj) =>
  JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const sha256Csp = (content) =>
  `'sha256-${crypto.createHash('sha256').update(content, 'utf8').digest('base64')}'`;

const sortEntries = (entries) =>
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

function collectAssets(absRoot) {
  const dataUriMap = new Map();
  const dirResolved = resolveContainedPath(absRoot, 'assets', {
    allowSymlinks: false,
    requireFile: false,
  });
  if (!dirResolved.ok || !dirResolved.stat.isDirectory()) return dataUriMap;
  const realRoot = fs.realpathSync(absRoot);

  const walk = (dir) => {
    const entries = sortEntries(fs.readdirSync(dir, { withFileTypes: true }));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = toPosixPath(path.relative(realRoot, full));
        const mime = MIME_TYPES[path.extname(entry.name).toLowerCase()] || 'application/octet-stream';
        const b64 = fs.readFileSync(full).toString('base64');
        dataUriMap.set(rel, `data:${mime};base64,${b64}`);
      }
    }
  };
  walk(dirResolved.realPath);
  return dataUriMap;
}

function inlineAssetRefs(text, assetMap) {
  if (!text || assetMap.size === 0) return text;

  const resolveAsset = (rawRel, suffix = '') => {
    if (suffix && suffix.includes('#')) return null; // preserve SVG/HTML #fragment references
    const normalized = rawRel.replace(/^(?:(?:\.\.\/)+|\.\/|\/)/, '');
    return assetMap.has(normalized) ? assetMap.get(normalized) : null;
  };

  // 1. CSS url(...) references (quoted or unquoted), anchored at url(...) boundary
  let out = text.replace(
    /url\(\s*(["']?)((?:(?:\.\.\/)+|\.\/|\/)?assets\/[^"'()\s<>#?]+)([?#][^"'()\s<>]*)?\1\s*\)/gi,
    (match, quote, rawRel, suffix) => {
      const uri = resolveAsset(rawRel, suffix);
      return uri ? `url(${quote}${uri}${quote})` : match;
    },
  );

  // 2. HTML quoted attribute values (e.g. src="/assets/logo.png", href="../assets/pic.webp")
  out = out.replace(
    /(=\s*)(["'])((?:(?:\.\.\/)+|\.\/|\/)?assets\/[^"'<>#?\s]+)([?#][^"'<>\s]*)?\2/gi,
    (match, eq, quote, rawRel, suffix) => {
      const uri = resolveAsset(rawRel, suffix);
      return uri ? `${eq}${quote}${uri}${quote}` : match;
    },
  );

  return out;
}

function collectHtmlDir(absRoot, subdir, assetMap) {
  const out = {};
  const dirResolved = resolveContainedPath(absRoot, subdir, {
    allowSymlinks: false,
    requireFile: false,
  });
  if (!dirResolved.ok || !dirResolved.stat.isDirectory()) return out;
  const realRoot = fs.realpathSync(absRoot);

  const walk = (cur) => {
    const entries = sortEntries(fs.readdirSync(cur, { withFileTypes: true }));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        const rel = toPosixPath(path.relative(realRoot, full));
        out[rel] = inlineAssetRefs(fs.readFileSync(full, 'utf8'), assetMap);
      }
    }
  };
  walk(dirResolved.realPath);
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

export function exportProject(root, { outFile, title, includeTimestamp = false } = {}) {
  const absRoot = path.resolve(root);
  const flowResolved = resolveContainedPath(absRoot, 'flow.json', {
    allowSymlinks: false,
    requireFile: true,
  });
  if (!flowResolved.ok) {
    throw new Error(`no flow.json in ${absRoot}`);
  }

  const targetOut = path.resolve(outFile || path.join(absRoot, 'preview.html'));
  for (const protectedDir of ['screens', 'components', 'assets']) {
    if (isPathInside(path.join(absRoot, protectedDir), targetOut)) {
      throw new Error(`refusing to write export inside project ${protectedDir}/ directory: ${targetOut}`);
    }
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowResolved.realPath, 'utf8'));
  } catch (err) {
    throw new Error(`invalid flow.json: ${err.message}`);
  }

  const assetMap = collectAssets(absRoot);
  const files = {};

  for (const styleFile of ['tokens.css', 'kit.css']) {
    const resolved = resolveContainedPath(absRoot, styleFile, {
      allowSymlinks: false,
      requireFile: true,
    });
    if (resolved.ok) {
      files[styleFile] = inlineAssetRefs(fs.readFileSync(resolved.realPath, 'utf8'), assetMap);
    }
  }

  const components = collectHtmlDir(absRoot, 'components', assetMap);
  Object.assign(files, components);

  const screens = collectHtmlDir(absRoot, 'screens', assetMap);
  Object.assign(files, screens);

  // Verify every flow.json node's screen file exists safely inside project root and is bundled.
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  let screenCount = Object.keys(screens).length;
  for (const n of nodes) {
    if (!n?.id) continue;
    const rel = n.file ? String(n.file).replace(/^\.?\//, '') : `screens/${n.id}.html`;
    const resolved = resolveContainedPath(absRoot, rel, {
      allowSymlinks: false,
      requireFile: true,
    });
    if (!resolved.ok) {
      if (resolved.reason === 'not_found' || resolved.reason === 'not_a_file') {
        throw new Error(`node "${n.id}" screen file not found: ${rel}`);
      }
      throw new Error(`node "${n.id}" screen path is not allowed (${resolved.reason}): ${rel}`);
    }
    if (!Object.prototype.hasOwnProperty.call(files, resolved.clean)) {
      files[resolved.clean] = inlineAssetRefs(fs.readFileSync(resolved.realPath, 'utf8'), assetMap);
      screenCount++;
    }
  }

  const fontsResolved = resolveContainedPath(absRoot, 'fonts.css', {
    allowSymlinks: false,
    requireFile: true,
  });
  const fontsCss = fontsResolved.ok
    ? inlineAssetRefs(fs.readFileSync(fontsResolved.realPath, 'utf8'), assetMap)
    : '';

  const viewerCss = fs.readFileSync(path.join(VIEWER_DIR, 'viewer.css'), 'utf8');
  const viewerScript = buildInlineViewerScript();
  const projectName = title || flow.title || deriveProjectName(absRoot);
  const projectId = `standalone:${projectName}`;

  const bundlePayload = {
    version: 1,
    ...(includeTimestamp ? { exportedAt: new Date().toISOString() } : {}),
    projectName,
    flow,
    files,
  };

  const bundleScriptBody = `window.__MOCKERY_BUNDLE__ = ${escScriptJson(bundlePayload)};`;
  const viewerScriptBody = `\n${viewerScript.replace(/<\/script/gi, '<\\/script')}\n  `;
  const bundleHash = sha256Csp(bundleScriptBody);
  const viewerHash = sha256Csp(viewerScriptBody);
  const exportCsp = [
    "default-src 'none'",
    `script-src ${bundleHash} ${viewerHash}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const shellHtml = fs.readFileSync(path.join(VIEWER_DIR, 'index.html'), 'utf8');
  const inlineStyles = [
    `  <meta http-equiv="Content-Security-Policy" content="${escHtml(exportCsp)}">`,
    `  <style>\n${escStyle(viewerCss)}\n  </style>`,
    fontsCss ? `  <style>\n${escStyle(fontsCss)}\n  </style>` : '',
  ].filter(Boolean).join('\n');

  const html = shellHtml
    .replaceAll('{{project-id}}', () => escHtml(projectId))
    .replace('<title>{{project-name}} · Mockery</title>', () => `<title>${escHtml(projectName)} · Mockery Preview</title>`)
    .replaceAll('{{project-name}}', () => escHtml(projectName))
    .replace('  <link rel="stylesheet" href="/__mockery/viewer.css">', () => inlineStyles)
    .replace(/\r?\n  <link rel="stylesheet" href="\/__mockery\/fonts\.css">/, '')
    .replace(/\r?\n  <script type="module" src="\/__mockery\/main\.js"><\/script>/, '')
    .replace('title="Hot reload connection"', 'title="Standalone exported preview"')
    .replace(
      '</body>',
      () => `  <script>${bundleScriptBody}</script>\n  <script>${viewerScriptBody}</script>\n</body>`,
    );

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
