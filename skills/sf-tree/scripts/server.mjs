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
import {
  findDefaultWorkGraphPath,
  loadWorkGraphFile,
} from "./work-analyzer.mjs";
import { fetchLinearGraph } from "./linear-adapter.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(SCRIPT_DIR, "ui.html");
const BIND_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_POLL_MS = 30000;
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
    <li><a href="/api/work-graph">/api/work-graph</a></li>
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
          onRelevantChange(fname);
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
        // Gracefully skip unwatchable directories.
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

function createSnapshotFileWatcher(filePath, onChange) {
  const absFile = path.resolve(filePath);
  const parentDir = path.dirname(absFile);
  const baseName = path.basename(absFile);
  let watcher = null;

  function start() {
    if (watcher) return;
    try {
      if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
        return;
      }
      watcher = fs.watch(parentDir, (_eventType, filename) => {
        const fname = filename ? String(filename) : null;
        if (fname && fname !== baseName) return;
        onChange();
      });
      watcher.on("error", () => {
        close();
      });
    } catch {
      watcher = null;
    }
  }

  function close() {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }

  start();
  return { start, close };
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
 * Create and start the live local sf-tree HTTP + SSE server (dual-mode: Pipeline Stages + Work Tech-Tree).
 */
export async function createLiveServer({
  workspaceRoot = process.cwd(),
  workGraphPath = null,
  linearProject = null,
  linearTeam = null,
  pollMs = DEFAULT_POLL_MS,
  view = "auto",
  port = DEFAULT_PORT,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  uiHtmlPath = UI_HTML_PATH,
  fetchLinearImpl = fetchLinearGraph,
} = {}) {
  const absRoot = path.resolve(workspaceRoot);
  const absWorkGraphPath = workGraphPath ? path.resolve(workGraphPath) : null;
  const hasDirectLinear = Boolean(linearProject || linearTeam);
  const sseClients = new Set();

  let debounceTimer = null;
  let workDebounceTimer = null;
  let pollTimer = null;
  let closed = false;

  // In-memory cache for direct Linear GraphQL mode
  let linearGraphCache = null;
  let linearError = null;
  let linearFetchInFlight = null;

  function resolveDefaultView(workAvailable) {
    if (view === "work") return "work";
    if (view === "pipeline") return "pipeline";
    return workAvailable ? "work" : "pipeline";
  }

  function getWorkGraphEnvelope() {
    if (hasDirectLinear) {
      const available = Boolean(linearGraphCache);
      const envelope = {
        available,
        default_view: resolveDefaultView(available || Boolean(linearError)),
        graph: linearGraphCache,
      };
      if (linearError) envelope.error = linearError;
      return envelope;
    }

    const activeFile = absWorkGraphPath || findDefaultWorkGraphPath(absRoot);
    if (!activeFile) {
      return {
        available: false,
        default_view: resolveDefaultView(false),
        graph: null,
      };
    }

    try {
      const graph = loadWorkGraphFile(activeFile);
      return {
        available: true,
        default_view: resolveDefaultView(true),
        graph,
      };
    } catch (err) {
      return {
        available: false,
        default_view: resolveDefaultView(Boolean(absWorkGraphPath)),
        graph: null,
        error: err.message,
      };
    }
  }

  function broadcastSseEvent(eventName, dataObj) {
    if (closed || sseClients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify(dataObj);
    } catch {
      return;
    }
    const frame = `event: ${eventName}\ndata: ${payload}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function broadcastGraph() {
    if (closed) return;
    watcherMgr.sync();
    if (sseClients.size === 0) return;
    try {
      broadcastSseEvent("graph", analyzeWorkspace(absRoot));
    } catch {
      // ignore
    }
  }

  function broadcastWorkGraph() {
    if (closed) return;
    if (sseClients.size === 0) return;
    broadcastSseEvent("work_graph", getWorkGraphEnvelope());
  }

  function scheduleBroadcast(changedFilename) {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastGraph();
      // Also push work_graph if repo-local docs/factory/work-graph.json might have changed
      if (!hasDirectLinear && !absWorkGraphPath) {
        if (!changedFilename || changedFilename === "work-graph.json" || changedFilename === "factory") {
          broadcastWorkGraph();
        }
      }
    }, debounceMs);
  }

  function scheduleWorkGraphBroadcast() {
    if (closed) return;
    if (workDebounceTimer) clearTimeout(workDebounceTimer);
    workDebounceTimer = setTimeout(() => {
      workDebounceTimer = null;
      broadcastWorkGraph();
    }, debounceMs);
  }

  async function refreshLinearCache() {
    if (!hasDirectLinear) {
      return { ok: false, status: 400, envelope: { error: "live_refresh_not_configured" } };
    }
    if (linearFetchInFlight) {
      return linearFetchInFlight;
    }
    linearFetchInFlight = (async () => {
      try {
        const fresh = await fetchLinearImpl({
          project: linearProject,
          team: linearTeam,
        });
        linearGraphCache = fresh;
        linearError = null;
        const envelope = getWorkGraphEnvelope();
        broadcastSseEvent("work_graph", envelope);
        return { ok: true, status: 200, envelope };
      } catch (err) {
        linearError = err.message || "Linear refresh failed";
        const envelope = getWorkGraphEnvelope();
        broadcastSseEvent("work_graph", envelope);
        return { ok: false, status: 502, envelope };
      } finally {
        linearFetchInFlight = null;
      }
    })();
    return linearFetchInFlight;
  }

  // Perform initial direct Linear fetch if configured
  if (hasDirectLinear) {
    await refreshLinearCache();
    if (typeof pollMs === "number" && pollMs > 0) {
      pollTimer = setInterval(() => {
        if (!closed) {
          refreshLinearCache().catch(() => {});
        }
      }, pollMs);
      if (typeof pollTimer.unref === "function") {
        pollTimer.unref();
      }
    }
  }

  const watcherMgr = createDirectoryWatcherManager(absRoot, scheduleBroadcast);
  const workSnapshotWatcher =
    !hasDirectLinear && absWorkGraphPath
      ? createSnapshotFileWatcher(absWorkGraphPath, scheduleWorkGraphBroadcast)
      : null;

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

  const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const rawUrl = req.url || "/";
    const qIdx = rawUrl.indexOf("?");
    const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

    if (hasUnsafeRawTraversal(rawPath)) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    // Strictly read-only: only POST /api/work-graph/refresh is allowed beyond GET/HEAD
    if (rawPath === "/api/work-graph/refresh") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (!hasDirectLinear) {
        sendJson(res, 400, {
          error: "live_refresh_not_configured",
          message:
            "Direct Linear GraphQL polling is not configured. Start with --linear-project or --linear-team and LINEAR_API_KEY.",
        });
        return;
      }
      const result = await refreshLinearCache();
      sendJson(res, result.status, result.envelope);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" });
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

    if (rawPath === "/api/work-graph") {
      sendJson(res, 200, getWorkGraphEnvelope());
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
        const initialPipeline = JSON.stringify(analyzeWorkspace(absRoot));
        res.write(`event: graph\ndata: ${initialPipeline}\n\n`);
      } catch {
        // ignore
      }

      try {
        const initialWork = JSON.stringify(getWorkGraphEnvelope());
        res.write(`event: work_graph\ndata: ${initialWork}\n\n`);
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
    if (workDebounceTimer) {
      clearTimeout(workDebounceTimer);
      workDebounceTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    clearInterval(heartbeatTimer);
    watcherMgr.closeAll();
    if (workSnapshotWatcher) {
      workSnapshotWatcher.close();
    }
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
    triggerWorkGraphRefresh: hasDirectLinear ? refreshLinearCache : broadcastWorkGraph,
  };
}

/**
 * CLI entrypoint helper: starts the live server, registers SIGINT/SIGTERM cleanup,
 * prints the URL, and optionally opens the browser.
 */
export async function startServer({
  workspaceRoot = process.cwd(),
  workGraphPath = null,
  linearProject = null,
  linearTeam = null,
  pollMs = DEFAULT_POLL_MS,
  view = "auto",
  port = DEFAULT_PORT,
  open = true,
} = {}) {
  const instance = await createLiveServer({
    workspaceRoot,
    workGraphPath,
    linearProject,
    linearTeam,
    pollMs,
    view,
    port,
  });
  process.stdout.write(`sf-tree live viewer running at ${instance.url}\n`);
  process.stdout.write(`Watching pipeline: ${path.resolve(workspaceRoot, FACTORY_DIR)}\n`);
  if (workGraphPath) {
    process.stdout.write(`Watching work-graph: ${path.resolve(workGraphPath)}\n`);
  } else if (linearProject || linearTeam) {
    const scope = linearProject ? `project=${linearProject}` : `team=${linearTeam}`;
    process.stdout.write(
      `Direct Linear GraphQL (${scope}, poll=${pollMs > 0 ? `${pollMs}ms` : "manual"})\n`
    );
  }
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
