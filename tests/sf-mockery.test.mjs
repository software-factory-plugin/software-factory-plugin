import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { checkProject, expandIncludes } from "../skills/sf-mockery/scripts/check.mjs";
import { exportProject } from "../skills/sf-mockery/scripts/export.mjs";
import { serve } from "../skills/sf-mockery/scripts/server.mjs";
import { findProject } from "../skills/sf-mockery/scripts/cli.mjs";
import { anchorSelector } from "../skills/sf-mockery/scripts/viewer/edges.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PULSEBOARD_MOCKUPS = path.join(REPO_ROOT, "evals", "fixtures", "pulseboard", "mockups");
const MOCKERY_CLI = path.join(REPO_ROOT, "skills", "sf-mockery", "scripts", "cli.mjs");

function makeTempDir(prefix = "sf-mock-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function invokeHandler(server, { method = "GET", url = "/", headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;

    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.chunks = [];
    res.writableEnded = false;
    res.destroyed = false;
    res.writeHead = (code, hdrs = {}) => {
      res.statusCode = code;
      for (const [k, v] of Object.entries(hdrs)) {
        res.headers[k.toLowerCase()] = v;
      }
      return res;
    };
    res.write = (chunk) => {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined) {
        res.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      }
      res.writableEnded = true;
      resolve({
        status: res.statusCode,
        headers: res.headers,
        body: res.chunks.join(""),
      });
      res.emit("close");
      return res;
    };

    server.emit("request", req, res);
  });
}

function openSseMock(server, { url = "/__events", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = "GET";
  req.url = url;
  req.headers = headers;

  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (code, hdrs = {}) => {
    res.statusCode = code;
    for (const [k, v] of Object.entries(hdrs)) {
      res.headers[k.toLowerCase()] = v;
    }
    return res;
  };
  res.write = (chunk) => {
    res.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    }
    res.writableEnded = true;
    res.emit("close");
    return res;
  };

  server.emit("request", req, res);
  return { req, res };
}

test("sf-mockery check: balanced <x-include> scanner handles nested slots, case-insensitivity, PulseBoard live markup, self-closing, and cycles", () => {
  // Live PulseBoard fixture check
  const errors = [];
  const used = new Set();
  const raw = fs.readFileSync(
    path.join(PULSEBOARD_MOCKUPS, "screens", "public-status.html"),
    "utf8"
  );
  const expanded = expandIncludes(
    PULSEBOARD_MOCKUPS,
    raw,
    "screens/public-status.html",
    errors,
    used
  );

  assert.equal(errors.length, 0);
  assert.ok(expanded.includes("</header>"), "Outer </header> must not be deleted");
  assert.match(expanded, /<\/div>\r?\n<\/header>/, "Topbar inner </div> before </header> must remain");
  assert.equal(expanded.includes("</x-include>"), false);

  const report = checkProject(PULSEBOARD_MOCKUPS);
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);

  // Nested <x-include> inside slot + case-insensitive <X-INCLUDE> + direct & indirect cycles + unclosed
  const tmp = makeTempDir("sf-inc-");
  try {
    fs.mkdirSync(path.join(tmp, "components"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "components", "card.html"), `<section class="card">{{slot}}</section>`);
    fs.writeFileSync(path.join(tmp, "components", "badge.html"), `<span class="badge">{{label|OK}}</span>`);
    fs.writeFileSync(path.join(tmp, "components", "self.html"), `<x-include src="self"></x-include>`);
    fs.writeFileSync(path.join(tmp, "components", "a.html"), `<x-include src="b"></x-include>`);
    fs.writeFileSync(path.join(tmp, "components", "b.html"), `<x-include src="a"></x-include>`);

    const nestedErrs = [];
    const nestedUsed = new Set();
    const nestedOut = expandIncludes(
      tmp,
      `<X-INCLUDE src="card"><div class="inner"><x-include src="badge" label="Live"></x-include></div></X-INCLUDE>`,
      "screens/home.html",
      nestedErrs,
      nestedUsed
    );
    assert.equal(nestedErrs.length, 0);
    assert.equal(nestedOut, `<section class="card"><div class="inner"><span class="badge">Live</span></div></section>`);
    assert.deepEqual([...nestedUsed].sort(), ["badge", "card"]);

    // Direct self-cycle
    const selfErrs = [];
    expandIncludes(tmp, `<x-include src="self"></x-include>`, "screens/self.html", selfErrs, new Set());
    assert.ok(selfErrs.some((e) => e.code === "include-cycle" && e.message.includes("self -> self")));

    // Indirect cycle
    const indErrs = [];
    expandIncludes(tmp, `<x-include src="a"></x-include>`, "screens/ind.html", indErrs, new Set());
    assert.ok(indErrs.some((e) => e.code === "include-cycle" && e.message.includes("a -> b -> a")));

    // Self-closing & unclosed & missing src
    const syntaxErrs = [];
    expandIncludes(
      tmp,
      `<x-include src="badge" /><x-include></x-include><x-include src="badge">unclosed`,
      "screens/bad.html",
      syntaxErrs,
      new Set()
    );
    const codes = new Set(syntaxErrs.map((e) => e.code));
    assert.ok(codes.has("self-closing-include"));
    assert.ok(codes.has("missing-include-src"));
    assert.ok(codes.has("unclosed-include"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sf-mockery check: comprehensive error & warning codes, prose/comment immunity, EISDIR safety, and symlink escape rejection", () => {
  // 1. Missing flow.json
  const emptyDir = makeTempDir("sf-check-empty-");
  try {
    const r = checkProject(emptyDir);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, "missing-flow");
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  // 2. Invalid JSON in flow.json
  const badJsonDir = makeTempDir("sf-check-badjson-");
  try {
    fs.writeFileSync(path.join(badJsonDir, "flow.json"), "{broken", "utf8");
    const r = checkProject(badJsonDir);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, "invalid-json");
  } finally {
    fs.rmSync(badJsonDir, { recursive: true, force: true });
  }

  // 3. Comprehensive negative suite
  const tmp = makeTempDir("sf-check-neg-");
  const outside = makeTempDir("sf-check-out-");
  try {
    fs.mkdirSync(path.join(tmp, "components"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "screens", "dir-as-file"), { recursive: true });
    fs.writeFileSync(path.join(outside, "escape.html"), "<p>escaped</p>", "utf8");
    fs.symlinkSync(path.join(outside, "escape.html"), path.join(tmp, "screens", "sym.html"));

    fs.writeFileSync(path.join(tmp, "tokens.css"), `@import url("foo.css");\n:root{}\n`);
    fs.writeFileSync(path.join(tmp, "kit.css"), `/* position: fixed */\n.ok{}\n`);
    fs.writeFileSync(path.join(tmp, "components", "styled-comp.html"), `<style>.x{color:red}</style><span>x</span>`);
    fs.writeFileSync(path.join(tmp, "components", "a.html"), `<x-include src="b"></x-include>`);
    fs.writeFileSync(path.join(tmp, "components", "b.html"), `<x-include src="a"></x-include>`);
    fs.writeFileSync(
      path.join(tmp, "screens", "s1.html"),
      `<!-- <script>alert(1)</script> position: fixed -->
       <p>Mentioning @media and 12vh in prose is safe.</p>
       <x-include src="styled-comp"></x-include>
       <x-include src="a" />
       <x-include src="a"></x-include>
       <x-include src="nonexistent"></x-include>
       <button data-goto="missing-node">Go</button>
       <img src="/assets/nope.png" />`
    );
    fs.writeFileSync(
      path.join(tmp, "screens", "s3.html"),
      `<div>Target screen</div>`
    );
    fs.writeFileSync(
      path.join(tmp, "flow.json"),
      JSON.stringify({
        sections: [{ title: "NoId" }, { id: "sec1" }, { id: "sec1" }],
        nodes: [
          { id: "s1", title: "S1", x: "bad", y: 0, w: 400, h: 300, section: "ghost", device: "watch" },
          { id: "s2", title: "S2", file: "screens/dir-as-file", x: 0, y: 0, w: -10, h: 300 },
          { id: "s3", title: "S3", x: 0, y: 0 }, // implicit dimensions
          { id: "s4", title: "S4", file: "screens/sym.html", x: 0, y: 0, w: 400, h: 300 },
          { id: "s5", title: "S5", file: "screens/does-not-exist.html", x: 0, y: 0, w: 400, h: 300 },
        ],
        edges: [
          { from: "s1" }, // invalid-edge
          { from: "s1", to: "ghost-node" }, // missing-edge-node
          { from: "s1", to: "s3", style: "neon-glow" }, // unknown-edge-style + unanchored-edge (no fromSelector/data-goto)
        ],
      })
    );

    const neg = checkProject(tmp);
    const errCodes = new Set(neg.errors.map((e) => e.code));
    const warnCodes = new Set(neg.warnings.map((w) => w.code));

    assert.equal(neg.ok, false);
    assert.ok(errCodes.has("self-closing-include"));
    assert.ok(errCodes.has("include-cycle"));
    assert.ok(errCodes.has("missing-component"));
    assert.ok(errCodes.has("invalid-coordinates"));
    assert.ok(errCodes.has("invalid-dimensions"));
    assert.ok(errCodes.has("invalid-device"));
    assert.ok(errCodes.has("missing-section"));
    assert.ok(errCodes.has("missing-section-id"));
    assert.ok(errCodes.has("duplicate-section-id"));
    assert.ok(errCodes.has("missing-screen"), "dir-as-file & missing screen must report missing-screen without EISDIR crash");
    assert.ok(errCodes.has("invalid-file-path"), "symlink escape must be rejected");
    assert.ok(errCodes.has("invalid-edge"));
    assert.ok(errCodes.has("missing-edge-node"));
    // Comments & prose must NOT trigger screen-lint false positives
    assert.equal(errCodes.has("screen-lint"), false);

    assert.ok(warnCodes.has("css-import-in-layer"));
    assert.ok(warnCodes.has("dangling-goto"));
    assert.ok(warnCodes.has("missing-asset"));
    assert.ok(warnCodes.has("implicit-dimensions"));
    assert.ok(warnCodes.has("component-style"));
    assert.ok(warnCodes.has("unknown-edge-style"));
    assert.ok(warnCodes.has("unanchored-edge"));

    // Real <script> and CSS rule violations DO trigger screen-lint
    fs.writeFileSync(
      path.join(tmp, "screens", "s3.html"),
      `<style>.bad { position: fixed; height: 100vh; } @media (max-width: 600px) {}</style><script>x()</script>`
    );
    const lintCheck = checkProject(tmp);
    assert.ok(lintCheck.errors.some((e) => e.code === "screen-lint" && e.file === "screens/s3.html"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("sf-mockery export: deterministic, SHA-256 CSP, vm.Script valid viewer JS, script breakout prevention, URL boundaries, and symlink skipping", () => {
  const tmp = makeTempDir("sf-exp-");
  const outside = makeTempDir("sf-exp-out-");
  try {
    fs.mkdirSync(path.join(tmp, "screens"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.png"), "TOP_SECRET_BYTES");
    fs.writeFileSync(path.join(tmp, "assets", "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(tmp, "assets", "leak.png"));
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(tmp, "screens", "leak.html"));
    fs.writeFileSync(path.join(tmp, "tokens.css"), `:root{--bg:#fff}`);
    fs.writeFileSync(path.join(tmp, "kit.css"), `.hero{background:url("../assets/logo.svg")}`);
    fs.writeFileSync(
      path.join(tmp, "screens", "home.html"),
      `<main>
        <!-- <script>alert("double-escape")</script> -->
        <img src="/assets/logo.svg" />
        <img src="../assets/logo.svg" />
        <img src="https://cdn.example.com/assets/logo.svg" />
        <svg><use href="/assets/logo.svg#icon-check"></use></svg>
      </main>`
    );
    fs.writeFileSync(
      path.join(tmp, "screens", "second.html"),
      `<main><img src="/assets/logo.svg" /></main>`
    );
    fs.writeFileSync(
      path.join(tmp, "flow.json"),
      JSON.stringify({
        title: "ExportTest",
        nodes: [
          { id: "home", title: "Home", w: 1200, h: 800, x: 0, y: 0 },
          { id: "second", title: "Second", w: 1200, h: 800, x: 1400, y: 0 },
        ],
        edges: [],
      })
    );

    const out1 = path.join(tmp, "preview-1.html");
    const out2 = path.join(tmp, "preview-2.html");
    const res1 = exportProject(tmp, { outFile: out1 });
    exportProject(tmp, { outFile: out2 });

    const html1 = fs.readFileSync(out1, "utf8");
    const html2 = fs.readFileSync(out2, "utf8");
    assert.equal(html1, html2, "Repeated exports must be byte-for-byte deterministic");
    assert.equal(res1.summary.assets, 1);
    assert.ok(res1.summary.assetBytes > 0);

    // Must enforce maxAssetBytes cap cleanly
    assert.throws(
      () => exportProject(tmp, { outFile: out1, maxAssetBytes: 5 }),
      /maxAssetBytes/
    );

    // Must not embed symlinked outside secret (neither via assets nor screens)
    assert.equal(html1.includes(Buffer.from("TOP_SECRET_BYTES").toString("base64")), false);
    assert.equal(html1.includes("TOP_SECRET_BYTES"), false);

    // Extract inline scripts and verify JS validity via vm.Script + exact SHA-256 CSP hashes
    const scripts = [...html1.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2);
    for (const s of scripts) {
      assert.doesNotThrow(() => new vm.Script(s));
    }

    const cspMatch = html1.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
    assert.ok(cspMatch, "Exported HTML must include CSP meta tag");
    const csp = cspMatch[1].replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, "script-src must not allow unsafe-inline");
    for (const s of scripts) {
      const digest = crypto.createHash("sha256").update(s, "utf8").digest("base64");
      assert.ok(csp.includes(`'sha256-${digest}'`), `CSP must include sha256 hash for inline script`);
    }

    // Verify bundle JSON escapes HTML5 breakout tokens and deduplicates assets (stored ONCE in bundle.assets)
    const bundleMatch = scripts[0].match(/window\.__MOCKERY_BUNDLE__\s*=\s*([\s\S]+);$/);
    assert.ok(bundleMatch);
    assert.equal(scripts[0].includes("<!--"), false, "escScriptJson must escape < as \\u003c");
    assert.equal(scripts[0].includes("<script"), false, "escScriptJson must escape <script");
    assert.ok(scripts[0].includes("\\u003c") && scripts[0].includes("\\u003e"));
    const bundle = JSON.parse(bundleMatch[1]);
    assert.equal(bundle.version, 2);
    const logoUri = bundle.assets["assets/logo.svg"];
    assert.ok(logoUri && logoUri.startsWith("data:image/svg+xml;base64,"));
    assert.equal(
      html1.split(logoUri).length - 1,
      1,
      "Each local asset data URI must appear exactly once in exported HTML (deduplicated)"
    );
    assert.equal(bundle.files["screens/home.html"].includes("data:image/svg+xml;base64,"), false);
    assert.equal(bundle.files["kit.css"].includes("data:image/svg+xml;base64,"), false);

    // Verify runtime resolveBundledAssetRefs resolves local refs while preserving external URLs & #fragments
    const screensSrc = fs.readFileSync(
      path.join(REPO_ROOT, "skills", "sf-mockery", "scripts", "viewer", "screens.js"),
      "utf8"
    );
    const assetSandbox = {
      CSSStyleSheet: class { replaceSync() {} },
      window: { __MOCKERY_BUNDLE__: bundle },
      document: {},
      console,
    };
    vm.runInNewContext(
      `${screensSrc.replace(/^\s*export\s+/gm, "")}\nthis.__resolve = resolveBundledAssetRefs;`,
      assetSandbox
    );
    const resolvedHome = assetSandbox.__resolve(bundle.files["screens/home.html"], bundle.assets);
    const resolvedKit = assetSandbox.__resolve(bundle.files["kit.css"], bundle.assets);
    assert.ok(resolvedHome.includes("https://cdn.example.com/assets/logo.svg"));
    assert.ok(resolvedHome.includes("/assets/logo.svg#icon-check"));
    assert.ok(resolvedHome.includes(`src="${logoUri}"`));
    assert.equal(resolvedHome.includes('src="../assets/logo.svg"'), false);
    assert.ok(resolvedKit.includes(`url("${logoUri}")`));

    // Reject writing --out inside protected subdirectories
    assert.throws(() => exportProject(tmp, { outFile: path.join(tmp, "screens", "evil.html") }));
    assert.throws(() => exportProject(tmp, { outFile: path.join(tmp, "components", "evil.html") }));
    assert.throws(() => exportProject(tmp, { outFile: path.join(tmp, "assets", "evil.html") }));

    // Real PulseBoard export also syntax-validates cleanly
    const pbOut = path.join(tmp, "pulseboard-preview.html");
    const pbRes = exportProject(PULSEBOARD_MOCKUPS, { outFile: pbOut });
    assert.equal(pbRes.ok, true);
    const pbHtml = fs.readFileSync(pbOut, "utf8");
    const pbScripts = [...pbHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(pbScripts.length, 2);
    for (const s of pbScripts) {
      assert.doesNotThrow(() => new vm.Script(s));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("sf-mockery viewer: sanitizer strips dangerous tags/handlers/URLs; edges.js uses zero innerHTML & VALID_EDGE_STYLES; renderer.js avoids innerHTML error cards", () => {
  // Direct pure-function test of anchorSelector from edges.js
  assert.equal(anchorSelector({ to: "checkout" }), '[data-goto="checkout"]');
  assert.equal(anchorSelector({ to: "checkout", fromSelector: "#buy-btn" }), "#buy-btn");
  assert.equal(anchorSelector({ to: 'bad"id' }), '[data-goto="bad\\"id"]');

  const edgesSrc = fs.readFileSync(
    path.join(REPO_ROOT, "skills", "sf-mockery", "scripts", "viewer", "edges.js"),
    "utf8"
  );
  assert.equal(/\.innerHTML\s*=/.test(edgesSrc), false, "edges.js must not assign innerHTML");
  assert.match(edgesSrc, /VALID_EDGE_STYLES\s*=\s*new Set\(\['dashed',\s*'error',\s*'success',\s*'muted'\]\)/);

  const rendererSrc = fs.readFileSync(
    path.join(REPO_ROOT, "skills", "sf-mockery", "scripts", "viewer", "renderer.js"),
    "utf8"
  );
  assert.equal(/<div[^>]*>Could not load/.test(rendererSrc), false, "renderer.js must not interpolate raw HTML error cards");
  assert.match(rendererSrc, /createTextNode\(`Could not load/);

  const screensSrc = fs.readFileSync(
    path.join(REPO_ROOT, "skills", "sf-mockery", "scripts", "viewer", "screens.js"),
    "utf8"
  );
  assert.match(screensSrc, /sanitizeHtmlFragment/);
  assert.match(screensSrc, /Include cycle detected/);
  for (const tag of ["'script'", "'iframe'", "'object'", "'embed'", "'foreignobject'"]) {
    assert.ok(screensSrc.includes(tag), `DISALLOWED_TAGS must include ${tag}`);
  }
  assert.match(screensSrc, /name\.startsWith\('on'\)/);
  assert.match(screensSrc, /javascript:/);
  assert.match(screensSrc, /vbscript:/);

  // Execute screens.js's isSafeUrl and sanitizeNodeTree against a minimal mock DOM in vm
  const sandbox = {
    CSSStyleSheet: class { replaceSync() {} },
    URL,
    console,
    window: {},
    document: {
      createElement(tag) {
        return { tagName: tag.toUpperCase(), innerHTML: "", content: null, style: {}, textContent: "" };
      },
    },
  };
  const runnableScreens = screensSrc
    .replace(/^\s*export\s+/gm, "")
    + "\nglobalThis.__testExports = { isSafeUrl, sanitizeNodeTree, DISALLOWED_TAGS };";
  vm.runInNewContext(runnableScreens, sandbox);

  const { isSafeUrl, sanitizeNodeTree } = sandbox.__testExports;
  assert.equal(isSafeUrl("javascript:alert(1)"), false);
  assert.equal(isSafeUrl("  JaVa\tScRiPt:alert(1)"), false);
  assert.equal(isSafeUrl("vbscript:msgbox(1)"), false);
  assert.equal(isSafeUrl("data:text/html,<script>1</script>"), false);
  assert.equal(isSafeUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isSafeUrl("/assets/logo.svg"), true);

  // Mock DOM elements to verify sanitizeNodeTree strips onerror, onload, javascript: href, <iframe>, <foreignObject>
  const makeMockEl = (tagName, attrsObj = {}) => {
    const attrMap = new Map(Object.entries(attrsObj));
    const el = {
      tagName: tagName.toUpperCase(),
      removed: false,
      get attributes() {
        return [...attrMap.entries()].map(([name, value]) => ({ name, value }));
      },
      removeAttribute(name) {
        attrMap.delete(name);
      },
      remove() {
        el.removed = true;
      },
      hasAttr(name) {
        return attrMap.has(name);
      },
    };
    return el;
  };
  const img = makeMockEl("img", { src: "/assets/ok.png", onerror: "alert(1)", onload: "x()" });
  const link = makeMockEl("a", { href: "javascript:alert(1)" });
  const iframe = makeMockEl("iframe", { src: "https://evil.example" });
  const foreignObj = makeMockEl("foreignObject", {});
  const all = [img, link, iframe, foreignObj];
  const mockRoot = {
    querySelectorAll: () => all,
    contains: (el) => !el.removed,
  };
  sanitizeNodeTree(mockRoot);
  assert.equal(img.removed, false);
  assert.equal(img.hasAttr("onerror"), false);
  assert.equal(img.hasAttr("onload"), false);
  assert.equal(img.hasAttr("src"), true);
  assert.equal(link.hasAttr("href"), false);
  assert.equal(iframe.removed, true);
  assert.equal(foreignObj.removed, true);
});

test("sf-mockery server: enforces Host guard, GET/HEAD-only, 400 on malformed URI, CSP, hashed project-id, symlink blocking, and SSE cap", async () => {
  const tmp = makeTempDir("sf-mock-srv-");
  const outside = makeTempDir("sf-mock-out-");
  try {
    fs.mkdirSync(path.join(tmp, "screens"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "flow.json"), JSON.stringify({ nodes: [], edges: [] }));
    fs.writeFileSync(path.join(tmp, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(outside, "secret.txt"), "HOST_SECRET");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "screens", "leak.txt"));

    const srv = await serve({ root: tmp, port: 0 });
    try {
      const validHost = `127.0.0.1:${srv.port}`;

      // DNS rebinding Host rejected (evil domain, wrong port, missing Host)
      for (const badHeader of [{ host: `evil.example:${srv.port}` }, { host: "127.0.0.1:9999" }, {}]) {
        const res = await invokeHandler(srv.server, { url: "/", headers: badHeader });
        assert.equal(res.status, 403);
      }

      // POST and DELETE rejected with 405 + Allow header
      for (const method of ["POST", "DELETE"]) {
        const badMethod = await invokeHandler(srv.server, {
          method,
          url: "/",
          headers: { host: validHost },
        });
        assert.equal(badMethod.status, 405);
        assert.equal(badMethod.headers.allow, "GET, HEAD");
      }

      // Malformed percent-encoding returns 400 (does not crash)
      for (const badUrl of ["/%E0%A4%A", "/%ZZ", "/%2e%2e/flow.json"]) {
        const badUri = await invokeHandler(srv.server, {
          url: badUrl,
          headers: { host: validHost },
        });
        assert.equal(badUri.status, 400);
      }

      // GET / returns strict CSP, X-Frame-Options, and hashed data-project (no raw absRoot)
      const indexRes = await invokeHandler(srv.server, {
        url: "/",
        headers: { host: validHost },
      });
      assert.equal(indexRes.status, 200);
      assert.equal(indexRes.headers["x-frame-options"], "DENY");
      assert.match(indexRes.headers["content-security-policy"] || "", /script-src 'self'/);
      assert.equal(indexRes.body.includes(tmp), false, "Raw absRoot must not be exposed in HTML");
      assert.match(indexRes.body, /data-project="project:[0-9a-f]{16}"/);

      // HEAD / omits body
      const headRes = await invokeHandler(srv.server, {
        method: "HEAD",
        url: "/",
        headers: { host: validHost },
      });
      assert.equal(headRes.status, 200);
      assert.equal(headRes.body, "");

      // Dotfile & symlink rejected with 403
      const dotRes = await invokeHandler(srv.server, {
        url: "/.env",
        headers: { host: validHost },
      });
      assert.equal(dotRes.status, 403);

      const symRes = await invokeHandler(srv.server, {
        url: "/screens/leak.txt",
        headers: { host: validHost },
      });
      assert.equal(symRes.status, 403);

      // Optional fonts.css fallback returns 200 empty CSS
      const fontsRes = await invokeHandler(srv.server, {
        url: "/__mockery/fonts.css",
        headers: { host: validHost },
      });
      assert.equal(fontsRes.status, 200);

      // SSE /__events rejects HEAD with 405, accepts GET up to cap (50), rejects 51st with 503
      const headSse = await invokeHandler(srv.server, {
        method: "HEAD",
        url: "/__events",
        headers: { host: validHost },
      });
      assert.equal(headSse.status, 405);

      const sseClients = [];
      for (let i = 0; i < 50; i += 1) {
        const c = openSseMock(srv.server, { headers: { host: validHost } });
        assert.equal(c.res.statusCode, 200);
        sseClients.push(c);
      }
      const overflow = await invokeHandler(srv.server, {
        url: "/__events",
        headers: { host: validHost },
      });
      assert.equal(overflow.status, 503);

      // Closing one client frees capacity for a new client
      sseClients[0].req.emit("close");
      const recovered = openSseMock(srv.server, { headers: { host: validHost } });
      assert.equal(recovered.res.statusCode, 200);
      sseClients.push(recovered);
      for (const c of sseClients) c.req.emit("close");
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("sf-mockery cli: safe ESM import, findProject(), --help, check --json, and missing/invalid flag handling", () => {
  assert.equal(typeof findProject, "function");
  assert.equal(findProject(PULSEBOARD_MOCKUPS), path.resolve(PULSEBOARD_MOCKUPS));

  const helpOut = execFileSync(process.execPath, [MOCKERY_CLI, "--help"], { encoding: "utf8" });
  assert.match(helpOut, /Usage:/);
  assert.match(helpOut, /export/);

  const checkOut = execFileSync(
    process.execPath,
    [MOCKERY_CLI, "check", PULSEBOARD_MOCKUPS, "--json"],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(checkOut);
  assert.equal(parsed.ok, true);

  // Missing flag value (--port with no arg) exits non-zero cleanly
  assert.throws(
    () => execFileSync(process.execPath, [MOCKERY_CLI, "serve", "--port"], { stdio: "pipe" }),
    (err) => err && err.status === 1
  );

  // Out-of-range port exits non-zero cleanly
  assert.throws(
    () => execFileSync(process.execPath, [MOCKERY_CLI, "serve", "--port", "99999"], { stdio: "pipe" }),
    (err) => err && err.status === 1
  );
});
