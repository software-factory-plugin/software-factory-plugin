import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  assertNode20,
  escHtml,
  hashShort,
  isDirectRun,
  posixShellQuote,
  toPosixPath,
} from "../lib/cli-utils.mjs";
import {
  createDebouncedWatcher,
  hasUnsafeRawPath,
  isPathInside,
  readContainedFile,
  resolveContainedPath,
  safeStatContainedFile,
} from "../lib/fs-safe.mjs";
import {
  BIND_HOST,
  buildSecurityHeaders,
  createSseHub,
  installGracefulShutdown,
  isAllowedLocalHost,
  isAllowedSameOrigin,
  listenWithFallback,
  safeDecodeRequestPath,
  sendHtml,
  sendJson,
  sendText,
} from "../lib/http-sse.mjs";

function makeTempDir(prefix = "sf-lib-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (code, hdrs = {}) => {
    res.statusCode = code;
    res.headers = hdrs;
    return res;
  };
  res.write = (chunk) => {
    if (res.throwOnWrite) throw new Error("socket write failed");
    res.chunks.push(String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(String(chunk));
    res.writableEnded = true;
    res.emit("close");
    return res;
  };
  return res;
}

test("cli-utils: assertNode20, escHtml, posixShellQuote, hashShort, toPosixPath, isDirectRun", () => {
  assert.doesNotThrow(() => assertNode20(20));
  assert.throws(() => assertNode20(999), /Node\.js >= 999\.0\.0/);

  assert.equal(
    escHtml(`<div class="a" data-x='b'>&</div>`),
    "&lt;div class=&quot;a&quot; data-x=&#39;b&#39;&gt;&amp;&lt;/div&gt;"
  );
  assert.equal(escHtml(null), "");
  assert.equal(escHtml(undefined), "");

  assert.equal(posixShellQuote("docs/factory/mockups"), "docs/factory/mockups");
  assert.equal(posixShellQuote("dir with spaces/a'b;id"), `'dir with spaces/a'\\''b;id'`);
  assert.equal(posixShellQuote("-rf"), "'-rf'");
  assert.equal(posixShellQuote(""), "''");

  assert.equal(hashShort("/tmp/project-a", 12).length, 12);
  assert.equal(hashShort("/tmp/project-a", 2).length, 4, "minimum digest length is clamped to 4");
  assert.equal(hashShort("/tmp/project-a"), hashShort("/tmp/project-a"));
  assert.notEqual(hashShort("/tmp/project-a"), hashShort("/tmp/project-b"));
  assert.equal(toPosixPath(path.join("a", "b", "c")), "a/b/c");
  assert.equal(isDirectRun(new URL("../lib/cli-utils.mjs", import.meta.url).href), false);
  assert.equal(isDirectRun(import.meta.url), true);
});

test("fs-safe: realpathSync containment rejects traversal, symlinked files, symlinked parent dirs, and missing/non-file paths", () => {
  const root = makeTempDir("sf-fs-root-");
  const outside = makeTempDir("sf-fs-out-");
  try {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "ok.txt"), "hello", "utf8");
    fs.writeFileSync(path.join(outside, "secret.txt"), "top-secret", "utf8");

    // Normal contained file
    const ok = readContainedFile(root, "sub/ok.txt");
    assert.equal(ok.ok, true);
    assert.equal(ok.content, "hello");
    assert.equal(ok.realPath, fs.realpathSync(path.join(root, "sub", "ok.txt")));
    assert.ok(safeStatContainedFile(root, "sub/ok.txt")?.isFile());

    // Base dir checks & sibling prefix boundary (isPathInside)
    assert.equal(isPathInside(root, root), true);
    assert.equal(isPathInside(root, path.join(root, "sub", "ok.txt")), true);
    assert.equal(isPathInside(root, `${root}-sibling`), false);
    assert.equal(isPathInside(root, path.join(root, "../outside")), false);
    assert.equal(resolveContainedPath(root, ".", { allowBase: false }).reason, "invalid_path");
    assert.equal(resolveContainedPath(root, ".", { allowBase: true }).ok, true);
    assert.equal(resolveContainedPath(root, "sub/\0bad").reason, "invalid_path");

    // Traversal & unsafe raw path checks
    assert.equal(resolveContainedPath(root, "../secret.txt").ok, false);
    assert.equal(hasUnsafeRawPath("/api/review/%2e%2e/secret"), true);
    assert.equal(hasUnsafeRawPath("/api/review/%2fsecret"), true);
    assert.equal(hasUnsafeRawPath("/api/review/%5csecret"), true);
    assert.equal(hasUnsafeRawPath("/api/review/%00secret"), true);
    assert.equal(hasUnsafeRawPath("/api/review/ok.md"), false);

    // Directory is not a file
    assert.equal(
      resolveContainedPath(root, "sub", { requireFile: true }).reason,
      "not_a_file"
    );

    // Missing file inside root -> not_found
    assert.equal(
      resolveContainedPath(root, "sub/missing.txt", { requireFile: true }).reason,
      "not_found"
    );

    // Symlinked file pointing outside
    const fileLink = path.join(root, "sub", "leak.txt");
    fs.symlinkSync(path.join(outside, "secret.txt"), fileLink);
    const fileLinkRes = readContainedFile(root, "sub/leak.txt");
    assert.equal(fileLinkRes.ok, false);
    assert.equal(fileLinkRes.reason, "symlink_not_allowed");
    assert.equal(safeStatContainedFile(root, "sub/leak.txt"), null);

    // Even with allowSymlinks:true, realpathSync containment rejects outside escape
    const escapedRes = resolveContainedPath(root, "sub/leak.txt", {
      allowSymlinks: true,
      requireFile: true,
    });
    assert.equal(escapedRes.ok, false);
    assert.equal(escapedRes.reason, "path_escape");

    // Symlinked directory pointing outside
    const dirLink = path.join(root, "linked-dir");
    fs.symlinkSync(outside, dirLink);
    const dirLinkRes = readContainedFile(root, "linked-dir/secret.txt");
    assert.equal(dirLinkRes.ok, false);
    assert.equal(dirLinkRes.reason, "symlink_not_allowed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("fs-safe: createDebouncedWatcher handles errors safely and close() cancels pending debounce timers", async () => {
  let errSeen = null;
  const missing = createDebouncedWatcher(path.join(os.tmpdir(), "nonexistent-sf-dir-xyz"), {
    onError: (e) => {
      errSeen = e;
    },
  });
  assert.equal(missing, null);
  assert.ok(errSeen instanceof Error);

  const dir = makeTempDir("sf-watch-");
  let handle = null;
  try {
    let changesAfterClose = 0;
    let watcherErrorSeen = null;
    handle = createDebouncedWatcher(dir, {
      debounceMs: 60,
      onChange: () => {
        changesAfterClose += 1;
      },
      onError: (e) => {
        watcherErrorSeen = e;
      },
    });
    assert.ok(handle);

    // Simulated watcher error routes cleanly to onError without unhandled throw
    handle.watcher.emit("error", new Error("simulated EMFILE"));
    assert.equal(watcherErrorSeen?.message, "simulated EMFILE");

    // Trigger a file write, then close immediately before debounceMs expires
    fs.writeFileSync(path.join(dir, "probe.txt"), "1", "utf8");
    handle.close();
    handle.close(); // idempotent

    await new Promise((r) => setTimeout(r, 90));
    assert.equal(changesAfterClose, 0, "close() must cancel pending debounce timers");
  } finally {
    handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("http-sse: Host DNS-rebinding guard, CSRF guard, malformed URI 400, and security headers", () => {
  assert.equal(BIND_HOST, "127.0.0.1");

  // Host allowlist
  assert.equal(isAllowedLocalHost("127.0.0.1:4173", 4173), true);
  assert.equal(isAllowedLocalHost("localhost:4173", 4173), true);
  assert.equal(isAllowedLocalHost("LOCALHOST:4173", 4173), true);
  assert.equal(isAllowedLocalHost("[::1]:4173", 4173), true);
  assert.equal(isAllowedLocalHost("evil.com:4173", 4173), false);
  assert.equal(isAllowedLocalHost("evil.example:4173", 4173), false);
  assert.equal(isAllowedLocalHost("127.0.0.1:5180", 4173), false);
  assert.equal(isAllowedLocalHost("", 4173), false);
  assert.equal(isAllowedLocalHost(undefined, 4173), false);
  assert.equal(isAllowedLocalHost("127.0.0.1:4173", 0), false);

  // Valid same-origin + custom CSRF header
  assert.equal(
    isAllowedSameOrigin(
      {
        headers: {
          host: "127.0.0.1:4173",
          origin: "http://127.0.0.1:4173",
          "sec-fetch-site": "same-origin",
          "x-sf-tree-refresh": "1",
        },
      },
      4173,
      { requiredHeader: "x-sf-tree-refresh" }
    ),
    true
  );

  // Reject cross-site Sec-Fetch-Site
  assert.equal(
    isAllowedSameOrigin(
      {
        headers: {
          host: "127.0.0.1:4173",
          origin: "http://127.0.0.1:4173",
          "sec-fetch-site": "cross-site",
          "x-sf-tree-refresh": "1",
        },
      },
      4173,
      { requiredHeader: "x-sf-tree-refresh" }
    ),
    false
  );

  // Reject mismatched Origin and non-http Origin protocol
  assert.equal(
    isAllowedSameOrigin(
      {
        headers: {
          host: "127.0.0.1:4173",
          origin: "https://evil.example",
          "x-sf-tree-refresh": "1",
        },
      },
      4173,
      { requiredHeader: "x-sf-tree-refresh" }
    ),
    false
  );
  assert.equal(
    isAllowedSameOrigin(
      {
        headers: {
          host: "127.0.0.1:4173",
          origin: "https://127.0.0.1:4173",
          "x-sf-tree-refresh": "1",
        },
      },
      4173,
      { requiredHeader: "x-sf-tree-refresh" }
    ),
    false
  );

  // Reject missing custom CSRF header
  assert.equal(
    isAllowedSameOrigin(
      {
        headers: {
          host: "127.0.0.1:4173",
          origin: "http://127.0.0.1:4173",
        },
      },
      4173,
      { requiredHeader: "x-sf-tree-refresh" }
    ),
    false
  );

  // Safe pathname decoding rejects malformed UTF-8 percent-encoding & traversal with 400
  const malformedUtf8 = safeDecodeRequestPath("/%E0%A4%A");
  assert.equal(malformedUtf8.ok, false);
  assert.equal(malformedUtf8.status, 400);
  assert.equal(safeDecodeRequestPath("/%ZZ").status, 400);
  assert.equal(safeDecodeRequestPath("/%2e%2e/etc/passwd").status, 400);
  assert.equal(safeDecodeRequestPath("/foo\\bar").status, 400);

  const okUrl = safeDecodeRequestPath("/api/artifact/vision?foo=1");
  assert.equal(okUrl.ok, true);
  assert.equal(okUrl.pathname, "/api/artifact/vision");
  assert.equal(okUrl.searchParams.get("foo"), "1");

  const secHeaders = buildSecurityHeaders({ csp: "default-src 'none'" });
  assert.equal(secHeaders["X-Frame-Options"], "DENY");
  assert.equal(secHeaders["X-Content-Type-Options"], "nosniff");
  assert.equal(secHeaders["Referrer-Policy"], "no-referrer");
  assert.equal(secHeaders["Cache-Control"], "no-store");
  assert.equal(secHeaders["Content-Security-Policy"], "default-src 'none'");
});

test("http-sse: HEAD body omission, SSE hub cap/eviction, listenWithFallback, and graceful shutdown", async () => {
  const hub = createSseHub({ maxClients: 1, heartbeatMs: 60_000, retryMs: 500 });

  // HEAD /events rejected with 405
  const headReq = new EventEmitter();
  headReq.method = "HEAD";
  const headRes = createMockRes();
  assert.equal(hub.accept(headReq, headRes), false);
  assert.equal(headRes.statusCode, 405);
  assert.equal(headRes.chunks.join(""), "");

  // sendHtml / sendJson / sendText HEAD omit body while preserving Content-Length & headers
  const htmlHead = createMockRes();
  sendHtml(htmlHead, 200, "<h1>ok</h1>", { method: "HEAD", csp: "default-src 'self'" });
  assert.equal(htmlHead.statusCode, 200);
  assert.equal(htmlHead.headers["Content-Security-Policy"], "default-src 'self'");
  assert.equal(htmlHead.headers["X-Frame-Options"], "DENY");
  assert.equal(htmlHead.headers["Content-Length"], Buffer.byteLength("<h1>ok</h1>"));
  assert.equal(htmlHead.chunks.join(""), "");

  const jsonHead = createMockRes();
  sendJson(jsonHead, 200, { ok: true }, { method: "HEAD" });
  assert.equal(jsonHead.statusCode, 200);
  assert.equal(jsonHead.chunks.join(""), "");

  const textHead = createMockRes();
  sendText(textHead, 200, "hello", { method: "HEAD" });
  assert.equal(textHead.statusCode, 200);
  assert.equal(textHead.chunks.join(""), "");

  // Accept 1st SSE client; 2nd gets 503
  const req1 = new EventEmitter();
  req1.method = "GET";
  const res1 = createMockRes();
  assert.equal(hub.accept(req1, res1, { initialChunks: ["event: hello\ndata: {}\n\n"] }), true);
  assert.equal(res1.statusCode, 200);
  assert.match(res1.chunks.join(""), /retry: 500/);
  assert.match(res1.chunks.join(""), /event: hello/);
  assert.equal(hub.size, 1);

  const req2 = new EventEmitter();
  req2.method = "GET";
  const res2 = createMockRes();
  assert.equal(hub.accept(req2, res2), false);
  assert.equal(res2.statusCode, 503);

  // Broadcast reaches active client; write failure evicts dead socket without throwing
  hub.broadcastEvent("ping", { n: 1 });
  assert.match(res1.chunks.join(""), /event: ping/);
  res1.throwOnWrite = true;
  assert.doesNotThrow(() => hub.broadcastEvent("ping", { n: 2 }));
  assert.equal(hub.size, 0);

  // After hub.close(), further accepts are rejected with 503
  hub.close();
  const req3 = new EventEmitter();
  req3.method = "GET";
  const res3 = createMockRes();
  assert.equal(hub.accept(req3, res3), false);
  assert.equal(res3.statusCode, 503);

  // installGracefulShutdown cleanly registers and removes SIGINT/SIGTERM listeners
  const beforeSigint = process.listenerCount("SIGINT");
  const beforeSigterm = process.listenerCount("SIGTERM");
  const uninstall = installGracefulShutdown(() => {});
  try {
    assert.equal(process.listenerCount("SIGINT"), beforeSigint + 1);
    assert.equal(process.listenerCount("SIGTERM"), beforeSigterm + 1);
  } finally {
    uninstall();
  }
  assert.equal(process.listenerCount("SIGINT"), beforeSigint);
  assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);

  // listenWithFallback steps past EADDRINUSE and honors strictPort (always close handles in finally)
  const server = http.createServer((_req, res) => sendJson(res, 200, { ok: true }));
  const server2 = http.createServer((_req, res) => sendJson(res, 200, { ok: true }));
  const server3 = http.createServer((_req, res) => sendJson(res, 200, { ok: true }));
  const closeServer = (srv) =>
    new Promise((resolve) => {
      if (!srv.listening) {
        resolve();
        return;
      }
      srv.close(() => resolve());
    });

  try {
    const port = await listenWithFallback(server, 0);
    assert.ok(port > 0);

    const port2 = await listenWithFallback(server2, port, { strictPort: false });
    assert.ok(
      port2 > port && port2 <= port + 20,
      `Expected fallback port in (${port}, ${port + 20}], got ${port2}`
    );

    await assert.rejects(
      () => listenWithFallback(server3, port, { strictPort: true }),
      (err) => err && err.code === "EADDRINUSE"
    );
  } finally {
    await Promise.all([closeServer(server), closeServer(server2), closeServer(server3)]);
  }
});
