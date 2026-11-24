// Mockery dev server: serves the bundled viewer and a project's files from its folder,
// and streams file changes over SSE (/__events). Zero dependencies (Node 20+ built-ins only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(SCRIPTS_ROOT, 'viewer');
const VIEWER_PREFIX = '/__mockery/'; // viewer files live under this prefix so projects can use any path
const IGNORE = /(^|\/)(\.|node_modules(\/|$))/; // dotfiles, .git, node_modules

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

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const toPosix = (p) => p.split(path.sep).join('/');

function sendFile(res, base, rel, fallback) {
  const absBase = path.resolve(base);
  const cleanRel = String(rel || '').replace(/^\/+/, '');
  const file = path.resolve(absBase, cleanRel);
  if (!file.startsWith(absBase + path.sep) || IGNORE.test(toPosix(path.relative(absBase, file)))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err && fallback !== undefined) data = fallback;
    else if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${cleanRel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// Recursive watch with a per-path debounce (editors often write a file in several steps).
function watchDir(dir, onChange) {
  const pending = new Map();
  try {
    return fs.watch(dir, { recursive: true }, (_event, name) => {
      if (!name) return;
      const rel = toPosix(String(name));
      if (IGNORE.test(rel)) return;
      clearTimeout(pending.get(rel));
      pending.set(rel, setTimeout(() => { pending.delete(rel); onChange(rel); }, 40));
    });
  } catch (err) {
    console.warn(`mockery: file watch unavailable for ${dir} (${err.message}); hot reload disabled`);
    return null;
  }
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
export function serve({ root, port = 5180, strictPort = false, dev = false }) {
  const absRoot = path.resolve(root);
  const clients = new Set();
  const watchers = [];
  const name = deriveProjectName(absRoot);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);

    if (p === '/__events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 500\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(VIEWER_DIR, 'index.html'), 'utf8')
        .replaceAll('{{project-name}}', escAttr(name))
        .replaceAll('{{project-id}}', escAttr(absRoot));
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-store' }).end(html);
    } else if (p === `${VIEWER_PREFIX}fonts.css`) {
      sendFile(res, absRoot, 'fonts.css', ''); // optional project file, loaded at document level
    } else if (p.startsWith(VIEWER_PREFIX)) {
      sendFile(res, VIEWER_DIR, p.slice(VIEWER_PREFIX.length));
    } else {
      sendFile(res, absRoot, p);
    }
  });

  const broadcast = (rel) => {
    const msg = `data: ${JSON.stringify({ path: rel })}\n\n`;
    for (const client of clients) client.write(msg);
    console.log(`changed  ${rel}`);
  };

  const rootWatcher = watchDir(absRoot, broadcast);
  if (rootWatcher) watchers.push(rootWatcher);
  if (dev) {
    const viewerWatcher = watchDir(VIEWER_DIR, (rel) => broadcast(`__mockery/${rel}`));
    if (viewerWatcher) watchers.push(viewerWatcher);
  }

  // Keep idle SSE connections alive through proxies and sleep.
  const ping = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, 30_000);
  ping.unref();

  const close = () => new Promise((resolve) => {
    clearInterval(ping);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    for (const client of clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    clients.clear();
    server.close(() => resolve());
  });

  // Without an explicit port, step past ports already taken (e.g. another project's viewer).
  return new Promise((resolve, reject) => {
    let onError;
    const attempt = (p, left) => {
      onError = (err) => {
        if (err.code === 'EADDRINUSE' && !strictPort && left > 0) attempt(p + 1, left - 1);
        else {
          close().finally(() => reject(err));
        }
      };
      server.once('error', onError);
      server.listen(p, '127.0.0.1');
    };
    server.once('listening', () => {
      server.off('error', onError);
      const { port: bound } = server.address();
      resolve({ url: `http://127.0.0.1:${bound}`, port: bound, name, server, close });
    });
    attempt(port, 20);
  });
}
