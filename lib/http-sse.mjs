// Shared localhost HTTP security, DNS-rebinding/CSRF guards, and bounded SSE hub (Node 20+ built-ins only).
import process from "node:process";
import { hasUnsafeRawPath } from "./fs-safe.mjs";

export const BIND_HOST = "127.0.0.1";

/**
 * Validate `req.headers.host` against strictly allowed loopback hosts for `boundPort`
 * to defeat DNS rebinding attacks against local dev servers.
 */
export function isAllowedLocalHost(hostHeader, boundPort) {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return false;
  const normalized = hostHeader.trim().toLowerCase();
  const port = Number(boundPort);
  if (!Number.isInteger(port) || port <= 0) return false;
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}`
  );
}

/**
 * Validate same-origin / CSRF invariants on state-changing or privileged local endpoints
 * (e.g., `POST /api/work-graph/refresh`).
 */
export function isAllowedSameOrigin(
  req,
  boundPort,
  { requiredHeader = null } = {}
) {
  const headers = req?.headers || {};
  if (!isAllowedLocalHost(headers.host, boundPort)) {
    return false;
  }

  const fetchSite = headers["sec-fetch-site"];
  if (
    typeof fetchSite === "string" &&
    fetchSite.trim() !== "" &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    return false;
  }

  const origin = headers.origin;
  if (typeof origin === "string" && origin.trim() !== "") {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:") return false;
    if (!isAllowedLocalHost(parsed.host, boundPort)) return false;
  }

  if (requiredHeader) {
    const val = headers[String(requiredHeader).toLowerCase()];
    if (typeof val !== "string" || !val.trim()) {
      return false;
    }
  }

  return true;
}

/**
 * Safely parse and decode `req.url`, rejecting malformed percent-encoding and raw traversal.
 */
export function safeDecodeRequestPath(rawUrl) {
  const input = typeof rawUrl === "string" && rawUrl ? rawUrl : "/";
  const qIdx = input.indexOf("?");
  const rawPath = qIdx >= 0 ? input.slice(0, qIdx) : input;

  if (hasUnsafeRawPath(rawPath)) {
    return { ok: false, status: 400, error: "invalid_path" };
  }

  let url;
  try {
    url = new URL(input, `http://${BIND_HOST}`);
  } catch {
    return { ok: false, status: 400, error: "invalid_path" };
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400, error: "invalid_path" };
  }

  if (hasUnsafeRawPath(pathname)) {
    return { ok: false, status: 400, error: "invalid_path" };
  }

  return {
    ok: true,
    rawPath,
    pathname,
    searchParams: url.searchParams,
  };
}

/**
 * Standard hardening headers applied across local HTML, JSON, and asset responses.
 */
export function buildSecurityHeaders({ csp = null, extra = {} } = {}) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...extra,
  };
  if (csp) {
    headers["Content-Security-Policy"] = csp;
  }
  return headers;
}

export function sendJson(res, statusCode, payload, { method = "GET", headers = {} } = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...buildSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

export function sendHtml(
  res,
  statusCode,
  html,
  { method = "GET", csp = null, headers = {} } = {}
) {
  const body = String(html ?? "");
  res.writeHead(statusCode, {
    ...buildSecurityHeaders({ csp }),
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

export function sendText(res, statusCode, text, { method = "GET", headers = {} } = {}) {
  const body = String(text ?? "");
  res.writeHead(statusCode, {
    ...buildSecurityHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

/**
 * Bounded Server-Sent Events (SSE) hub with automatic write-error eviction and heartbeat.
 */
export function createSseHub({
  maxClients = 50,
  heartbeatMs = 25_000,
  retryMs = 2_000,
} = {}) {
  const clients = new Set();
  let closed = false;

  function safeWrite(client, chunk) {
    try {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
        return false;
      }
      client.write(chunk);
      return true;
    } catch {
      clients.delete(client);
      try {
        client.end();
      } catch {
        // ignore
      }
      return false;
    }
  }

  const heartbeat = setInterval(() => {
    if (closed) return;
    for (const client of [...clients]) {
      safeWrite(client, ": ping\n\n");
    }
  }, heartbeatMs);
  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  return {
    get size() {
      return clients.size;
    },

    accept(req, res, { initialChunks = [] } = {}) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" }, { method: req.method });
        return false;
      }
      if (closed || clients.size >= maxClients) {
        sendJson(res, 503, { error: "too_many_sse_clients" }, { method: req.method });
        return false;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      });

      clients.add(res);
      const cleanup = () => clients.delete(res);
      req.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);

      if (!safeWrite(res, `retry: ${retryMs}\n\n`)) {
        return false;
      }
      for (const chunk of initialChunks) {
        if (!safeWrite(res, chunk)) break;
      }
      return true;
    },

    broadcastEvent(eventName, payload) {
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      const chunk = eventName
        ? `event: ${eventName}\ndata: ${data}\n\n`
        : `data: ${data}\n\n`;
      for (const client of [...clients]) {
        safeWrite(client, chunk);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const client of [...clients]) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      clients.clear();
    },
  };
}

/**
 * Bind an HTTP server strictly to `127.0.0.1` with optional sequential port fallback on EADDRINUSE.
 */
export function listenWithFallback(
  server,
  startPort,
  { host = BIND_HOST, strictPort = false, maxAttempts = 20 } = {}
) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let currentPort = startPort;

    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    const onError = (err) => {
      if (
        err &&
        err.code === "EADDRINUSE" &&
        !strictPort &&
        currentPort > 0 &&
        attempts < maxAttempts
      ) {
        attempts += 1;
        currentPort += 1;
        server.listen(currentPort, host);
        return;
      }
      cleanup();
      reject(err);
    };

    const onListening = () => {
      cleanup();
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : currentPort;
      resolve(boundPort);
    };

    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(currentPort, host);
  });
}

/**
 * Register idempotent SIGINT/SIGTERM graceful shutdown handlers and return an uninstall function.
 */
export function installGracefulShutdown(closeFn) {
  let shuttingDown = false;
  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve()
      .then(() => closeFn())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
