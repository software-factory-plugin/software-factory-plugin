// Mockery dev server: serves the bundled viewer and a project's files from its folder,
// and streams file changes over SSE (/__events). Zero dependencies (Node 22+ built-ins only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAllowedLocalHost,
  safeDecodeRequestPath,
  buildSecurityHeaders,
  sendText,
  sendHtml,
  createSseHub,
  listenWithFallback,
  installGracefulShutdown,
} from '../../../lib/http-sse.mjs';
import {
  resolveContainedPath,
  createDebouncedWatcher,
} from '../../../lib/fs-safe.mjs';
import {
  escHtml,
  hashShort,
  toPosixPath,
} from '../../../lib/cli-utils.mjs';

const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(SCRIPTS_ROOT, 'viewer');
const VIEWER_PREFIX = '/__mockery/'; // viewer files live under this prefix so projects can use any path
const IGNORE = /(^|\/)(\.|node_modules(\/|$))/; // dotfiles, .git, node_modules
const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function sendFile(res, base, rel, { method = 'GET', fallback } = {}) {
  const cleanRel = String(rel || '').replace(/^\/+/, '');
  const posixRel = toPosixPath(cleanRel);
  if (!cleanRel || IGNORE.test(posixRel)) {
    sendText(res, 403, 'Forbidden', { method });
    return;
  }

  const resolved = resolveContainedPath(base, cleanRel, {
    allowSymlinks: false,
    requireFile: true,
  });

  if (!resolved.ok) {
    if (
      resolved.reason === 'path_escape' ||
      resolved.reason === 'symlink_not_allowed' ||
      resolved.reason === 'invalid_path'
    ) {
      sendText(res, 403, 'Forbidden', { method });
      return;
    }
    if (resolved.reason === 'not_found' && fallback !== undefined) {
      const buf = Buffer.isBuffer(fallback) ? fallback : Buffer.from(String(fallback), 'utf8');
      res.writeHead(200, {
        ...buildSecurityHeaders(),
        'Content-Type': MIME_TYPES[path.extname(cleanRel).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
      });
      if (method === 'HEAD') res.end();
      else res.end(buf);
      return;
    }
    sendText(res, 404, `Not found: ${cleanRel}`, { method });
    return;
  }

  if (IGNORE.test(resolved.clean)) {
    sendText(res, 403, 'Forbidden', { method });
    return;
  }

  fs.readFile(resolved.realPath, (err, data) => {
    if (err) {
      sendText(res, 404, `Not found: ${cleanRel}`, { method });
      return;
    }
    res.writeHead(200, {
      ...buildSecurityHeaders(),
      'Content-Type': MIME_TYPES[path.extname(resolved.realPath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    if (method === 'HEAD') res.end();
    else res.end(data);
  });
}

export function deriveProjectName(absRoot) {
  const base = path.basename(absRoot);
  if (base === 'mockups') {
    const parent = path.dirname(absRoot);
    const parentBase = path.basename(parent);
    if (parentBase === 'factory' && path.basename(path.dirname(parent)) === 'docs') {
      return path.basename(path.dirname(path.dirname(parent)));
    }
    return parentBase;
  }
  return base;
}

// Serve one project folder. `dev` also watches the bundled viewer files.
export async function serve({ root, port = 5180, strictPort = false, dev = false, handleSignals = false }) {
  const absRoot = path.resolve(root);
  const watchers = [];
  const name = deriveProjectName(absRoot);
  const projectId = `project:${hashShort(absRoot, 16)}`;
  const sse = createSseHub({ maxClients: 50, heartbeatMs: 30_000, retryMs: 500 });
  let activePort = 0;

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const boundPort = activePort || (typeof server.address() === 'object' && server.address()?.port) || 0;

    if (!isAllowedLocalHost(req.headers.host, boundPort)) {
      sendText(res, 403, 'Forbidden', { method });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed', {
        method,
        headers: { Allow: 'GET, HEAD' },
      });
      return;
    }

    const decoded = safeDecodeRequestPath(req.url);
    if (!decoded.ok) {
      sendText(res, decoded.status, 'Bad Request', { method });
      return;
    }

    const p = decoded.pathname;
    if (p === '/__events') {
      sse.accept(req, res);
    } else if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(VIEWER_DIR, 'index.html'), 'utf8')
        .replaceAll('{{project-name}}', () => escHtml(name))
        .replaceAll('{{project-id}}', () => escHtml(projectId));
      sendHtml(res, 200, html, { method, csp: VIEWER_CSP });
    } else if (p === `${VIEWER_PREFIX}fonts.css`) {
      sendFile(res, absRoot, 'fonts.css', { method, fallback: '' }); // optional project file, loaded at document level
    } else if (p.startsWith(VIEWER_PREFIX)) {
      sendFile(res, VIEWER_DIR, p.slice(VIEWER_PREFIX.length), { method });
    } else {
      sendFile(res, absRoot, p, { method });
    }
  });

  const broadcast = (rel) => {
    sse.broadcastEvent('', { path: rel });
    console.log(`changed  ${rel}`);
  };

  const rootWatcher = createDebouncedWatcher(absRoot, {
    recursive: true,
    debounceMs: 40,
    filter: (rel) => Boolean(rel) && !IGNORE.test(rel),
    onChange: broadcast,
    onError: (err) => {
      console.warn(`mockery: file watch unavailable for ${absRoot} (${err.message}); hot reload disabled`);
    },
  });
  if (rootWatcher) watchers.push(rootWatcher);

  if (dev) {
    const viewerWatcher = createDebouncedWatcher(VIEWER_DIR, {
      recursive: true,
      debounceMs: 40,
      filter: (rel) => Boolean(rel) && !IGNORE.test(rel),
      onChange: (rel) => broadcast(`__mockery/${rel}`),
      onError: (err) => {
        console.warn(`mockery: file watch unavailable for ${VIEWER_DIR} (${err.message}); hot reload disabled`);
      },
    });
    if (viewerWatcher) watchers.push(viewerWatcher);
  }

  let uninstallSignals = null;
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    if (uninstallSignals) {
      uninstallSignals();
      uninstallSignals = null;
    }
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers.length = 0;
    sse.close();
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  };

  try {
    const bound = await listenWithFallback(server, port, { strictPort, maxAttempts: 20 });
    activePort = bound;
    if (handleSignals) {
      uninstallSignals = installGracefulShutdown(close);
    }
    return { url: `http://127.0.0.1:${bound}`, port: bound, name, server, close };
  } catch (err) {
    await close();
    throw err;
  }
}
