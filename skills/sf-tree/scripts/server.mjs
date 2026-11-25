import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BIND_HOST,
  isAllowedLocalHost,
  isAllowedSameOrigin,
  safeDecodeRequestPath,
  buildSecurityHeaders,
  sendJson,
  sendHtml,
  createSseHub,
  listenWithFallback,
  installGracefulShutdown,
} from "../../../lib/http-sse.mjs";
import {
  resolveContainedPath,
  readContainedFile,
} from "../../../lib/fs-safe.mjs";
import {
  analyzeWorkspaceAsync,
  extractSystemState,
  sanitizeMockupsDir,
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
const UI_DIR = path.join(SCRIPT_DIR, "ui");
const UI_HTML_PATH = path.join(UI_DIR, "index.html");
const DEFAULT_PORT = 4173;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_POLL_MS = 30000;
const MIN_POLL_MS = 5000;
const HEARTBEAT_MS = 25000;
const MAX_SSE_CLIENTS = 50;

export const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const UI_MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
});

const FALLBACK_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Software Factory Tech-Tree</title>
</head>
<body>
  <h1>Software Factory Tech-Tree Server</h1>
  <p>The live server is running, but <code>ui/index.html</code> is not installed yet.</p>
  <ul>
    <li><a href="/api/graph">/api/graph</a></li>
    <li><a href="/api/work-graph">/api/work-graph</a></li>
    <li><a href="/events">/events</a></li>
  </ul>
</body>
</html>`;

function assertValidServerOptions({ port, pollMs }) {
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(`Invalid port: ${port} (expected integer 0..65535)`);
  }
  if (pollMs !== null && pollMs !== undefined && pollMs !== 0) {
    if (
      typeof pollMs !== "number" ||
      !Number.isFinite(pollMs) ||
      !Number.isInteger(pollMs) ||
      pollMs < MIN_POLL_MS
    ) {
      throw new Error(
        `Invalid pollMs: ${pollMs} (expected 0 to disable or finite integer >= ${MIN_POLL_MS})`
      );
    }
  }
}

function readUnexpectedBody(req) {
  return new Promise((resolve) => {
    if (req.complete) {
      resolve(false);
      return;
    }
    let sawData = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("close", onClose);
      req.off("error", onError);
    };
    const onData = (chunk) => {
      if (chunk && chunk.length > 0) {
        sawData = true;
        cleanup();
        req.resume();
        resolve(true);
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(sawData);
    };
    const onClose = () => {
      cleanup();
      resolve(sawData);
    };
    const onError = () => {
      cleanup();
      resolve(true);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("close", onClose);
    req.on("error", onError);
  });
}

function detectConfiguredMockupsDir(workspaceRoot) {
  const res = readContainedFile(workspaceRoot, `${FACTORY_DIR}/06b-mockery.md`);
  if (!res.ok) return DEFAULT_MOCKUPS_DIR;
  const extracted = extractSystemState(res.content);
  const candidate = extracted?.state?.mockups_dir;
  return sanitizeMockupsDir(workspaceRoot, candidate);
}

function createDirectoryWatcherManager(workspaceRoot, onRelevantChange) {
  const watchers = new Map();
  let activeMockupsDir = detectConfiguredMockupsDir(workspaceRoot);

  function resolveContainedDir(relPath) {
    const res = resolveContainedPath(workspaceRoot, relPath, {
      allowBase: false,
      allowSymlinks: false,
      requireFile: false,
    });
    if (!res.ok || !res.stat || !res.stat.isDirectory()) return null;
    return res.realPath;
  }

  function getWatchTargets() {
    const mockupsDirRel = sanitizeMockupsDir(workspaceRoot, activeMockupsDir);
    const targets = [
      { dir: path.resolve(workspaceRoot), filter: (name) => !name || name === "docs", direct: true },
    ];

    const docsDir = resolveContainedDir("docs");
    if (docsDir) {
      targets.push({ dir: docsDir, filter: (name) => !name || name === "factory" });
    }
    const factoryDir = resolveContainedDir(FACTORY_DIR);
    if (factoryDir) {
      targets.push({ dir: factoryDir, filter: () => true });
    }
    const reviewsDir = resolveContainedDir(REVIEWS_DIR);
    if (reviewsDir) {
      targets.push({ dir: reviewsDir, filter: () => true });
    }

    const mockupsDir = resolveContainedDir(mockupsDirRel);
    if (mockupsDir) {
      targets.push({ dir: mockupsDir, filter: () => true });
      const componentsDir = resolveContainedDir(`${mockupsDirRel}/components`);
      if (componentsDir) {
        targets.push({ dir: componentsDir, filter: () => true });
      }
      const screensDir = resolveContainedDir(`${mockupsDirRel}/screens`);
      if (screensDir) {
        targets.push({ dir: screensDir, filter: () => true });
      }
    }

    // If custom mockups_dir is configured, also keep watching parent directory segments inside docs/factory
    // so creating the custom mockups_dir later is detected automatically.
    if (mockupsDirRel !== DEFAULT_MOCKUPS_DIR) {
      const parentRel = path.posix.dirname(mockupsDirRel);
      if (parentRel && parentRel !== "." && parentRel !== FACTORY_DIR) {
        const parentDir = resolveContainedDir(parentRel);
        if (parentDir) {
          targets.push({ dir: parentDir, filter: () => true });
        }
      }
    }

    return targets;
  }

  function sync(nextMockupsDir = null) {
    if (typeof nextMockupsDir === "string" && nextMockupsDir.trim()) {
      activeMockupsDir = sanitizeMockupsDir(workspaceRoot, nextMockupsDir);
    } else {
      activeMockupsDir = detectConfiguredMockupsDir(workspaceRoot);
    }

    const targets = getWatchTargets();
    const desiredDirs = new Set();

    for (const target of targets) {
      if (target.direct) {
        let isDir = false;
        try {
          isDir = fs.existsSync(target.dir) && fs.statSync(target.dir).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) continue;
      }

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
  return {
    sync,
    closeAll,
    getActiveMockupsDir: () => activeMockupsDir,
    getWatchedDirs: () => [...watchers.keys()],
  };
}

function createSnapshotFileWatcher(
  filePath,
  onChange,
  { retryInitialMs = 500, retryMaxMs = 5000 } = {}
) {
  const absFile = path.resolve(filePath);
  const parentDir = path.dirname(absFile);
  const baseName = path.basename(absFile);
  let watcher = null;
  let retryTimer = null;
  let retryDelay = retryInitialMs;
  let closed = false;

  function scheduleRestart(notifyAfterRecover = false) {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (closed) return;
      const started = start();
      if (started && notifyAfterRecover) {
        onChange();
      } else if (!started) {
        retryDelay = Math.min(retryMaxMs, retryDelay * 2);
        scheduleRestart(notifyAfterRecover);
      }
    }, retryDelay);
    if (typeof retryTimer.unref === "function") {
      retryTimer.unref();
    }
  }

  function closeWatcherOnly() {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }

  function start() {
    if (closed || watcher) return Boolean(watcher);
    try {
      if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
        scheduleRestart(true);
        return false;
      }
      watcher = fs.watch(parentDir, (_eventType, filename) => {
        const fname = filename ? String(filename) : null;
        if (fname && fname !== baseName) return;
        onChange();
      });
      watcher.on("error", () => {
        closeWatcherOnly();
        if (!closed) {
          retryDelay = Math.min(retryMaxMs, Math.max(retryInitialMs, retryDelay));
          scheduleRestart(true);
        }
      });
      retryDelay = retryInitialMs;
      return true;
    } catch {
      watcher = null;
      scheduleRestart(true);
      return false;
    }
  }

  function close() {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    closeWatcherOnly();
  }

  start();
  return { start, close };
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
  uiDir = UI_DIR,
  fetchLinearImpl = fetchLinearGraph,
} = {}) {
  assertValidServerOptions({ port, pollMs });

  const absRoot = path.resolve(workspaceRoot);
  const absWorkGraphPath = workGraphPath ? path.resolve(workGraphPath) : null;
  const absUiDir = path.resolve(uiDir);
  const hasDirectLinear = Boolean(linearProject || linearTeam);
  const sseHub = createSseHub({
    maxClients: MAX_SSE_CLIENTS,
    heartbeatMs: HEARTBEAT_MS,
    retryMs: 2000,
  });

  let boundPort = null;
  let debounceTimer = null;
  let workDebounceTimer = null;
  let pollTimer = null;
  let closed = false;

  // In-memory cache for direct Linear GraphQL mode
  let linearGraphCache = null;
  let linearError = null;
  let linearFetchInFlight = null;

  // Deduplicate concurrent async workspace analyses so bursts coalesce cleanly.
  let graphAnalysisInFlight = null;
  function getPipelineGraphAsync() {
    if (graphAnalysisInFlight) {
      return graphAnalysisInFlight;
    }
    graphAnalysisInFlight = analyzeWorkspaceAsync(absRoot)
      .then((graph) => {
        if (!closed && watcherMgr) {
          watcherMgr.sync(graph.mockery?.mockups_dir || null);
        }
        return graph;
      })
      .finally(() => {
        graphAnalysisInFlight = null;
      });
    return graphAnalysisInFlight;
  }

  function sanitizeErrorMessage(err, fallback = "Operation failed") {
    const raw = typeof err === "string" ? err : err?.message;
    if (typeof raw !== "string" || !raw.trim()) return fallback;
    let msg = raw.trim();
    if (absWorkGraphPath) {
      msg = msg.replaceAll(absWorkGraphPath, path.basename(absWorkGraphPath));
    }
    if (absRoot) {
      msg = msg.replaceAll(absRoot, "<workspace>");
    }
    msg = msg
      .replace(/(^|[\s("'`])(?:\/[A-Za-z0-9._@-]+){2,}/g, "$1<path>")
      .replace(/(^|[\s("'`])[A-Za-z]:\\[^\s)"'`]+/g, "$1<path>")
      .replace(/[\r\n]+/g, " ")
      .trim();
    return msg || fallback;
  }

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
        error: sanitizeErrorMessage(err, "Failed to load work-graph"),
      };
    }
  }

  async function broadcastGraph() {
    if (closed) return;
    watcherMgr.sync();
    if (sseHub.size === 0) return;
    try {
      const graph = await getPipelineGraphAsync();
      if (!closed && sseHub.size > 0) {
        sseHub.broadcastEvent("graph", graph);
      }
    } catch {
      // ignore transient analysis errors
    }
  }

  function broadcastWorkGraph() {
    if (closed) return;
    if (sseHub.size === 0) return;
    sseHub.broadcastEvent("work_graph", getWorkGraphEnvelope());
  }

  function scheduleBroadcast(changedFilename) {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastGraph().catch(() => {});
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
        if (!closed && sseHub.size > 0) {
          sseHub.broadcastEvent("work_graph", envelope);
        }
        return { ok: true, status: 200, envelope };
      } catch (err) {
        linearError = sanitizeErrorMessage(err, "Linear refresh failed");
        const envelope = getWorkGraphEnvelope();
        if (!closed && sseHub.size > 0) {
          sseHub.broadcastEvent("work_graph", envelope);
        }
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

  function serveStaticUiAsset(res, pathname, method) {
    const relAsset = pathname.slice("/ui/".length);
    if (!relAsset || relAsset.endsWith("/")) {
      sendJson(res, 404, { error: "not_found" }, { method });
      return;
    }

    const ext = path.extname(relAsset).toLowerCase();
    const mimeType = UI_MIME_TYPES[ext];
    if (!mimeType) {
      sendJson(res, 403, { error: "unsupported_asset_type" }, { method });
      return;
    }

    const resolved = resolveContainedPath(absUiDir, relAsset, {
      allowBase: false,
      allowSymlinks: false,
      requireFile: true,
    });

    if (!resolved.ok) {
      if (resolved.reason === "not_found" || resolved.reason === "not_a_file") {
        sendJson(res, 404, { error: "not_found" }, { method });
        return;
      }
      sendJson(res, 403, { error: resolved.reason }, { method });
      return;
    }

    const body = fs.readFileSync(resolved.realPath);
    res.writeHead(200, {
      ...buildSecurityHeaders({ csp: ext === ".html" ? UI_CSP : null }),
      "Content-Type": mimeType,
      "Content-Length": body.length,
    });
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(body);
    }
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    try {
      const addr = server.address();
      const activePort = boundPort ?? (typeof addr === "object" && addr ? addr.port : null);
      if (!isAllowedLocalHost(req.headers.host, activePort)) {
        sendJson(res, 403, { error: "forbidden_host" }, { method });
        return;
      }

      const parsedPath = safeDecodeRequestPath(req.url);
      if (!parsedPath.ok) {
        sendJson(res, parsedPath.status, { error: parsedPath.error }, { method });
        return;
      }
      const { pathname, searchParams } = parsedPath;

      // Strictly read-only: only POST /api/work-graph/refresh is allowed beyond GET/HEAD
      if (pathname === "/api/work-graph/refresh") {
        if (method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" }, { method });
          return;
        }
        if (
          !isAllowedSameOrigin(req, activePort, {
            requiredHeader: "x-sf-tree-refresh",
          })
        ) {
          sendJson(res, 403, { error: "forbidden_origin" }, { method });
          return;
        }

        const rawContentLength = req.headers["content-length"];
        if (rawContentLength !== undefined) {
          const parsedLen = Number(rawContentLength);
          if (!Number.isFinite(parsedLen) || parsedLen < 0) {
            sendJson(res, 400, { error: "invalid_content_length" }, { method });
            return;
          }
          if (parsedLen > 0) {
            sendJson(res, 413, { error: "payload_not_allowed" }, { method });
            return;
          }
        }
        if (await readUnexpectedBody(req)) {
          sendJson(res, 413, { error: "payload_not_allowed" }, { method });
          return;
        }

        if (!hasDirectLinear) {
          sendJson(
            res,
            400,
            {
              error: "live_refresh_not_configured",
              message:
                "Direct Linear GraphQL polling is not configured. Start with --linear-project or --linear-team and LINEAR_API_KEY.",
            },
            { method }
          );
          return;
        }
        const result = await refreshLinearCache();
        sendJson(res, result.status, result.envelope, { method });
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" }, { method });
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        let html = FALLBACK_UI_HTML;
        try {
          if (fs.existsSync(uiHtmlPath)) {
            html = fs.readFileSync(uiHtmlPath, "utf8");
          }
        } catch {
          html = FALLBACK_UI_HTML;
        }
        sendHtml(res, 200, html, { method, csp: UI_CSP });
        return;
      }

      if (pathname.startsWith("/ui/")) {
        serveStaticUiAsset(res, pathname, method);
        return;
      }

      if (pathname === "/api/graph") {
        const graph = await getPipelineGraphAsync();
        sendJson(res, 200, graph, { method });
        return;
      }

      if (pathname === "/api/work-graph") {
        sendJson(res, 200, getWorkGraphEnvelope(), { method });
        return;
      }

      if (pathname.startsWith("/api/artifact/")) {
        const phase = pathname.slice("/api/artifact/".length);
        if (
          !phase ||
          phase.includes("/") ||
          phase.includes("\\") ||
          phase.includes("..")
        ) {
          sendJson(res, 400, { error: "invalid_phase" }, { method });
          return;
        }
        const detail = readArtifactDetail(absRoot, phase);
        if (!detail) {
          sendJson(res, 404, { error: "unknown_phase" }, { method });
          return;
        }
        sendJson(res, 200, detail, { method });
        return;
      }

      if (pathname.startsWith("/api/review/")) {
        const filename = pathname.slice("/api/review/".length);
        if (!filename || filename.includes("/")) {
          sendJson(res, 400, { error: "invalid_filename" }, { method });
          return;
        }
        const result = readReviewDetail(absRoot, filename);
        if (result.error) {
          sendJson(res, result.status, { error: result.error }, { method });
          return;
        }
        sendJson(res, 200, result.data, { method });
        return;
      }

      if (pathname === "/events") {
        const sendInitial = searchParams.get("initial") !== "0";
        const initialChunks = [];
        if (sendInitial && method === "GET" && sseHub.size < MAX_SSE_CLIENTS) {
          try {
            const initialPipeline = JSON.stringify(await getPipelineGraphAsync());
            initialChunks.push(`event: graph\ndata: ${initialPipeline}\n\n`);
          } catch {
            // ignore
          }
          try {
            const initialWork = JSON.stringify(getWorkGraphEnvelope());
            initialChunks.push(`event: work_graph\ndata: ${initialWork}\n\n`);
          } catch {
            // ignore
          }
        }
        sseHub.accept(req, res, { initialChunks });
        return;
      }

      sendJson(res, 404, { error: "not_found" }, { method });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" }, { method });
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  });

  boundPort = await listenWithFallback(server, port, { host: BIND_HOST });
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
    watcherMgr.closeAll();
    if (workSnapshotWatcher) {
      workSnapshotWatcher.close();
    }
    sseHub.close();
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
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
    getWatchedDirs: () => watcherMgr.getWatchedDirs(),
    getActiveMockupsDir: () => watcherMgr.getActiveMockupsDir(),
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

  installGracefulShutdown(() => instance.close());

  return instance;
}
