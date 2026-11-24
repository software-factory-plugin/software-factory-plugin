import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  analyzeWorkspace,
  readArtifactDetail,
  readReviewDetail,
  FACTORY_DIR,
  REVIEWS_DIR,
  DEFAULT_MOCKUPS_DIR,
} from "./analyzer.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(SCRIPT_DIR, "ui.html");
const BIND_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 25000;

const FALLBACK_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Software Factory Tech-Tree</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; color: #111827; background: #f9fafb; }
    code { background: #e5e7eb; padding: 0.15rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Software Factory Tech-Tree Server</h1>
  <p>The live server is running, but <code>ui.html</code> is not installed yet.</p>
  <ul>
    <li><a href="/api/graph">/api/graph</a></li>
    <li><a href="/events">/events</a></li>
  </ul>
</body>
</html>`;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function hasUnsafeRawTraversal(rawPath) {
  const lower = rawPath.toLowerCase();
  return (
    lower.includes("..") ||
    lower.includes("%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("\\") ||
    lower.includes("%00") ||
    lower.includes("\0")
  );
}

function createDirectoryWatcherManager(workspaceRoot, onRelevantChange) {
  const watchers = new Map();

  function getWatchTargets() {
    const docsDir = path.resolve(workspaceRoot, "docs");
    const factoryDir = path.resolve(workspaceRoot, FACTORY_DIR);
    const reviewsDir = path.resolve(workspaceRoot, REVIEWS_DIR);
    const mockupsDir = path.resolve(workspaceRoot, DEFAULT_MOCKUPS_DIR);
    const componentsDir = path.join(mockupsDir, "components");

    return [
      { dir: path.resolve(workspaceRoot), filter: (name) => !name || name === "docs" },
      { dir: docsDir, filter: (name) => !name || name === "factory" },
      { dir: factoryDir, filter: () => true },
      { dir: reviewsDir, filter: () => true },
      { dir: mockupsDir, filter: () => true },
      { dir: componentsDir, filter: () => true },
    ];
  }

  function sync() {
    const targets = getWatchTargets();
    const desiredDirs = new Set();

    for (const target of targets) {
      let isDir = false;
      try {
        isDir = fs.existsSync(target.dir) && fs.statSync(target.dir).isDirectory();
      } catch {
        isDir = false;
      }

      if (!isDir) continue;
      desiredDirs.add(target.dir);

      if (watchers.has(target.dir)) continue;

      try {
        const watcher = fs.watch(target.dir, (_eventType, filename) => {
          const fname = filename ? String(filename) : null;
          if (!target.filter(fname)) return;
          onRelevantChange();
        });
        watcher.on("error", () => {
          try {
            watcher.close();
          } catch {
            // ignore
          }
          watchers.delete(target.dir);
        });
        watchers.set(target.dir, watcher);
      } catch {
        // Gracefully skip unwatcheable directories.
      }
    }

    for (const [dir, watcher] of watchers.entries()) {
      if (!desiredDirs.has(dir)) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watchers.delete(dir);
      }
    }
  }

  function closeAll() {
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.clear();
  }

  sync();
  return { sync, closeAll };
}

function listenWithFallback(server, preferredPort) {
  const maxAttempts = preferredPort === 0 ? 1 : 20;

  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryPort(portToTry) {
      const onError = (err) => {
        server.off("listening", onListening);
        if (err && err.code === "EADDRINUSE" && preferredPort !== 0) {
          attempt += 1;
          if (attempt < maxAttempts) {
            tryPort(preferredPort + attempt);
            return;
          }
          if (attempt === maxAttempts) {
            tryPort(0);
            return;
          }
        }
        reject(err);
      };

      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : portToTry);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(portToTry, BIND_HOST);
    }

    tryPort(preferredPort);
  });
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore browser launch failures in headless environments.
  }
}

/**
 * Create and start the live local sf-tree HTTP + SSE server.
 */
export async function createLiveServer({
  workspaceRoot = process.cwd(),
  port = DEFAULT_PORT,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  uiHtmlPath = UI_HTML_PATH,
} = {}) {
  const absRoot = path.resolve(workspaceRoot);
  const sseClients = new Set();
  let debounceTimer = null;
  let closed = false;

  function broadcastGraph() {
    if (closed) return;
    watcherMgr.sync();
    if (sseClients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify(analyzeWorkspace(absRoot));
    } catch {
      return;
    }
    const frame = `event: graph\ndata: ${payload}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function scheduleBroadcast() {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastGraph();
    }, debounceMs);
  }

  const watcherMgr = createDirectoryWatcherManager(absRoot, scheduleBroadcast);

  const heartbeatTimer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(": ping\n\n");
      } catch {
        sseClients.delete(res);
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }

  const server = http.createServer((req, res) => {
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const rawUrl = req.url || "/";
    const qIdx = rawUrl.indexOf("?");
    const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

    if (hasUnsafeRawTraversal(rawPath)) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    if (rawPath === "/" || rawPath === "/index.html") {
      let html = FALLBACK_UI_HTML;
      try {
        if (fs.existsSync(uiHtmlPath)) {
          html = fs.readFileSync(uiHtmlPath, "utf8");
        }
      } catch {
        html = FALLBACK_UI_HTML;
      }
      sendHtml(res, 200, html);
      return;
    }

    if (rawPath === "/api/graph") {
      const graph = analyzeWorkspace(absRoot);
      sendJson(res, 200, graph);
      return;
    }

    if (rawPath.startsWith("/api/artifact/")) {
      const rawSeg = rawPath.slice("/api/artifact/".length);
      if (!rawSeg || rawSeg.includes("/")) {
        sendJson(res, 400, { error: "invalid_phase" });
        return;
      }
      let phase;
      try {
        phase = decodeURIComponent(rawSeg);
      } catch {
        sendJson(res, 400, { error: "invalid_phase" });
        return;
      }
      if (phase.includes("/") || phase.includes("\\") || phase.includes("..")) {
        sendJson(res, 400, { error: "invalid_phase" });
        return;
      }
      const detail = readArtifactDetail(absRoot, phase);
      if (!detail) {
        sendJson(res, 404, { error: "unknown_phase" });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (rawPath.startsWith("/api/review/")) {
      const rawSeg = rawPath.slice("/api/review/".length);
      if (!rawSeg || rawSeg.includes("/")) {
        sendJson(res, 400, { error: "invalid_filename" });
        return;
      }
      let filename;
      try {
        filename = decodeURIComponent(rawSeg);
      } catch {
        sendJson(res, 400, { error: "invalid_filename" });
        return;
      }
      const result = readReviewDetail(absRoot, filename);
      if (result.error) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 200, result.data);
      return;
    }

    if (rawPath === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      res.write("retry: 2000\n\n");
      sseClients.add(res);

      try {
        const initial = JSON.stringify(analyzeWorkspace(absRoot));
        res.write(`event: graph\ndata: ${initial}\n\n`);
      } catch {
        // ignore
      }

      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  const boundPort = await listenWithFallback(server, port);
  const url = `http://${BIND_HOST}:${boundPort}`;

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearInterval(heartbeatTimer);
    watcherMgr.closeAll();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    server,
    host: BIND_HOST,
    port: boundPort,
    url,
    close,
    triggerRefresh: broadcastGraph,
  };
}

/**
 * CLI entrypoint helper: starts the live server, registers SIGINT/SIGTERM cleanup,
 * prints the URL, and optionally opens the browser.
 */
export async function startServer({
  workspaceRoot = process.cwd(),
  port = DEFAULT_PORT,
  open = true,
} = {}) {
  const instance = await createLiveServer({ workspaceRoot, port });
  process.stdout.write(`sf-tree live viewer running at ${instance.url}\n`);
  process.stdout.write(`Watching ${path.resolve(workspaceRoot, FACTORY_DIR)}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  if (open) {
    openBrowser(instance.url);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await instance.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return instance;
}
