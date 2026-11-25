// Zero-dependency headless Chrome/Chromium CDP E2E tests (Node 22+ built-in WebSocket only).
// Verifies live sf-tree UI, live sf-mockery viewer (Shadow DOM + XSS blocking + click-through),
// and standalone exported file:// preview.html (SHA-256 CSP + deduplicated runtime assets).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLiveServer } from "../../skills/sf-tree/scripts/server.mjs";
import { serve as serveMockery } from "../../skills/sf-mockery/scripts/server.mjs";
import { exportProject } from "../../skills/sf-mockery/scripts/export.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PULSEBOARD_FIXTURE = path.join(REPO_ROOT, "evals", "fixtures", "pulseboard");
const PULSEBOARD_MOCKUPS = path.join(PULSEBOARD_FIXTURE, "mockups");

function findChromeBinary() {
  const envBin = process.env.CHROME_BIN || process.env.CHROMIUM_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/opt/homebrew/bin/chromium",
          "/usr/local/bin/chromium",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }

  const lookupCmd = process.platform === "win32" ? "where" : "which";
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge"]) {
    const res = spawnSync(lookupCmd, [name], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  }
  return null;
}

async function launchBrowser(chromeBin) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cdp-profile-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--window-size=1440,900",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];

  const child = spawn(chromeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrLog = "";

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chrome DevTools WS URL. stderr:\n${stderrLog}`));
    }, 15_000);

    const onData = (chunk) => {
      stderrLog += chunk.toString("utf8");
      const m = stderrLog.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve(m[1]);
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (code ${code}). stderr:\n${stderrLog}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome CDP WebSocket")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (ev) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${ev?.message || "connection failed"}`));
    });
  });

  let nextId = 1;
  const pending = new Map();
  const eventListeners = new Set();

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of eventListeners) fn(msg);
    }
  });

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, 15_000);
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      ws.send(JSON.stringify(payload));
    });
  }

  async function openPage(url) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);

    const pageErrors = [];
    const consoleErrors = [];
    const cspErrors = [];

    const onEvent = (msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        pageErrors.push(d?.exception?.description || d?.text || "Runtime.exceptionThrown");
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        consoleErrors.push(txt);
      } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        const entry = msg.params.entry;
        const txt = entry.url ? `${entry.text || ""} (${entry.url})` : entry.text || "";
        if (/Content Security Policy/i.test(txt)) cspErrors.push(txt);
        else consoleErrors.push(txt);
      }
    };
    eventListeners.add(onEvent);

    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out loading ${url}`)), 15_000);
      const waitLoad = (msg) => {
        if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
          clearTimeout(timer);
          eventListeners.delete(waitLoad);
          resolve();
        }
      };
      eventListeners.add(waitLoad);
    });

    await send("Page.navigate", { url }, sessionId);
    await loaded;

    async function evalJs(expression) {
      const res = await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (res.exceptionDetails) {
        throw new Error(
          `evalJs failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`
        );
      }
      return res.result?.value;
    }

    async function waitFor(predicateExpr, timeoutMs = 10_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const val = await evalJs(`Boolean(${predicateExpr})`);
        if (val) return true;
        await new Promise((r) => setTimeout(r, 80));
      }
      throw new Error(
        `Timed out waiting for: ${predicateExpr}\npageErrors=${JSON.stringify(pageErrors)}\ncspErrors=${JSON.stringify(cspErrors)}\nconsoleErrors=${JSON.stringify(consoleErrors)}`
      );
    }

    async function close() {
      eventListeners.delete(onEvent);
      try {
        await send("Target.closeTarget", { targetId });
      } catch {
        // ignore
      }
    }

    return { evalJs, waitFor, pageErrors, consoleErrors, cspErrors, close };
  }

  async function close() {
    try {
      await Promise.race([
        send("Browser.close"),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      // ignore
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 150));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore Windows transient lock cleanup
    }
  }

  return { openPage, close };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

test("headless Chrome E2E: sf-tree UI, sf-mockery Shadow DOM + XSS guard, and standalone file:// preview.html", async (t) => {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    if (process.env.CI === "true") {
      assert.fail("Chrome/Chromium binary not found on CI runner");
    }
    t.skip("Chrome/Chromium binary not installed locally");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sf-e2e-"));
  const browser = await launchBrowser(chromeBin);
  try {
    // -------------------------------------------------------------------------
    // 1. Live sf-tree Web UI (strict non-inline CSP, Pipeline + Work views, hover stability)
    // -------------------------------------------------------------------------
    const wsDir = path.join(tmp, "workspace");
    copyDir(PULSEBOARD_FIXTURE, path.join(wsDir, "docs", "factory"));
    const workGraphFile = path.join(tmp, "work-graph.json");
    fs.writeFileSync(
      workGraphFile,
      JSON.stringify({
        schema_version: "1.0",
        source: { kind: "json_snapshot", workspace: "PulseBoard" },
        projects: [{ id: "P1", name: "Core Launch" }],
        milestones: [{ id: "M1", name: "Wave 1", project_id: "P1" }],
        items: [
          { id: "PB-1", title: "DB Schema", status: "done", estimate: 2, project_id: "P1", milestone_id: "M1", blocked_by: [] },
          { id: "PB-2", title: "API Routes", status: "todo", estimate: 3, project_id: "P1", milestone_id: "M1", blocked_by: ["PB-1"] },
          { id: "PB-3", title: "UI Polish", status: "todo", estimate: 5, project_id: "P1", milestone_id: "M1", blocked_by: ["PB-2"] },
        ],
      })
    );

    const treeSrv = await createLiveServer({
      workspaceRoot: wsDir,
      workGraphPath: workGraphFile,
      port: 0,
      pollMs: 0,
    });
    try {
      const page = await browser.openPage(`http://127.0.0.1:${treeSrv.port}/`);
      try {
        // When a work-graph snapshot is present, sf-tree boots into Work Tech-Tree view first
        await page.waitFor(`document.querySelectorAll("#dag-nodes .work-node[data-work-id]").length === 3`);
        const workState = await page.evalJs(`({
          workCards: document.querySelectorAll("#dag-nodes .work-node[data-work-id]").length,
          cpText: document.getElementById("wmetric-cp")?.textContent?.trim(),
        })`);
        assert.equal(workState.workCards, 3);
        assert.match(workState.cpText || "", /8 pts/);

        // Switch to Pipeline Stages view and verify all 9 nodes + non-destructive hover class toggling
        await page.evalJs(`document.getElementById("btn-view-pipeline").click()`);
        await page.waitFor(`document.querySelectorAll("#dag-nodes .dag-node[data-phase]").length >= 9`);
        const pipeState = await page.evalJs(`(() => {
          const cards = document.querySelectorAll("#dag-nodes .dag-node[data-phase]");
          const edges = document.querySelectorAll("#dag-edges path");
          const arch = document.querySelector('#dag-nodes .dag-node[data-phase="architecture"]');
          window.__ARCH_REF__ = arch;
          arch.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          const sameAfterEnter = document.querySelector('#dag-nodes .dag-node[data-phase="architecture"]') === window.__ARCH_REF__;
          arch.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
          const sameAfterLeave = document.querySelector('#dag-nodes .dag-node[data-phase="architecture"]') === window.__ARCH_REF__;
          arch.click();
          return {
            cardCount: cards.length,
            edgeCount: edges.length,
            sameAfterEnter,
            sameAfterLeave,
            coreText: document.getElementById("metric-core-text")?.textContent?.trim(),
          };
        })()`);

        assert.equal(pipeState.cardCount, 9, "All 8 core stages + optional Mockery 6b must render");
        assert.ok(pipeState.edgeCount >= 8, "Pipeline SVG edges must render");
        assert.equal(pipeState.sameAfterEnter, true, "Hover enter must toggle classes without DOM teardown");
        assert.equal(pipeState.sameAfterLeave, true, "Hover leave must toggle classes without DOM teardown");
        assert.equal(pipeState.coreText, "8/8 Core");

        assert.deepEqual(page.pageErrors, [], `sf-tree had page errors: ${page.pageErrors.join("; ")}`);
        assert.deepEqual(page.cspErrors, [], `sf-tree had CSP violations: ${page.cspErrors.join("; ")}`);
        assert.deepEqual(page.consoleErrors, [], `sf-tree had console errors: ${page.consoleErrors.join("; ")}`);
      } finally {
        await page.close();
      }
    } finally {
      await treeSrv.close();
    }

    // -------------------------------------------------------------------------
    // 2. Clean PulseBoard sf-mockery Live Viewer + Standalone file:// preview.html
    //    (Shadow DOM, deduplicated assets/brand.svg across 2 screens, 0 CSP/page/console errors)
    // -------------------------------------------------------------------------
    const mockDir = path.join(tmp, "mockups");
    copyDir(PULSEBOARD_MOCKUPS, mockDir);
    fs.mkdirSync(path.join(mockDir, "assets"), { recursive: true });
    const brandSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0ea5e9"/></svg>`;
    fs.writeFileSync(path.join(mockDir, "assets", "brand.svg"), brandSvg, "utf8");

    const pubScreenPath = path.join(mockDir, "screens", "public-status.html");
    const origPub = fs.readFileSync(pubScreenPath, "utf8");
    fs.writeFileSync(pubScreenPath, `${origPub}\n<img id="brand-img" src="/assets/brand.svg" alt="brand" />\n`, "utf8");
    const adminScreenPath = path.join(mockDir, "screens", "admin-dashboard.html");
    fs.appendFileSync(adminScreenPath, `\n<img id="brand-img-2" src="../assets/brand.svg" alt="brand" />\n`, "utf8");

    const mockSrv = await serveMockery({ root: mockDir, port: 0 });
    try {
      const page = await browser.openPage(`http://127.0.0.1:${mockSrv.port}/`);
      try {
        await page.waitFor(`
          document.querySelectorAll("#frames .frame").length === 4 &&
          [...document.querySelectorAll("#frames .frame .frame-screen")].every(
            (h) => h.shadowRoot && h.shadowRoot.children.length > 0
          ) &&
          document.querySelectorAll("#edges .edge").length >= 1
        `);

        const liveMock = await page.evalJs(`(() => {
          const pubHost = document.querySelector('#frames .frame[data-id="public-status"] .frame-screen');
          const brandImg = pubHost.shadowRoot.getElementById("brand-img");
          return {
            frameCount: document.querySelectorAll("#frames .frame").length,
            edgeCount: document.querySelectorAll("#edges .edge").length,
            brandSrc: brandImg ? brandImg.getAttribute("src") : null,
          };
        })()`);

        assert.equal(liveMock.frameCount, 4);
        assert.ok(liveMock.edgeCount >= 1);
        assert.equal(liveMock.brandSrc, "/assets/brand.svg");

        // Verify focusing a frame via keyboard Enter selects it cleanly
        await page.evalJs(`(() => {
          const el = document.querySelector('#frames .frame[data-id="public-status"]');
          el.focus();
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        })()`);
        await page.waitFor(`document.querySelector('#frames .frame[data-id="public-status"]').classList.contains("is-selected")`);

        assert.deepEqual(page.pageErrors, [], `sf-mockery live had page errors: ${page.pageErrors.join("; ")}`);
        assert.deepEqual(page.cspErrors, [], `sf-mockery live had CSP violations: ${page.cspErrors.join("; ")}`);
        assert.deepEqual(page.consoleErrors, [], `sf-mockery live had console errors: ${page.consoleErrors.join("; ")}`);
      } finally {
        await page.close();
      }
    } finally {
      await mockSrv.close();
    }

    // Export clean PulseBoard mockups and verify file:// preview.html + deduplicated assets
    const outFile = path.join(tmp, "preview.html");
    const exported = exportProject(mockDir, { outFile });
    assert.equal(exported.ok, true);
    assert.equal(exported.summary.assets, 1);

    const exportedHtml = fs.readFileSync(outFile, "utf8");
    const expectedBrandUri = `data:image/svg+xml;base64,${Buffer.from(brandSvg, "utf8").toString("base64")}`;
    assert.equal(
      exportedHtml.split(expectedBrandUri).length - 1,
      1,
      "Shared brand.svg must be embedded once in exported preview.html"
    );

    const filePage = await browser.openPage(pathToFileURL(outFile).href);
    try {
      await filePage.waitFor(`
        document.querySelectorAll("#frames .frame").length === 4 &&
        [...document.querySelectorAll("#frames .frame .frame-screen")].every(
          (h) => h.shadowRoot && h.shadowRoot.children.length > 0
        ) &&
        document.querySelectorAll("#edges .edge").length >= 1
      `);

      const offlineState = await filePage.evalJs(`(() => {
        const pubHost = document.querySelector('#frames .frame[data-id="public-status"] .frame-screen');
        const adminHost = document.querySelector('#frames .frame[data-id="admin-dashboard"] .frame-screen');
        return {
          bundleVersion: window.__MOCKERY_BUNDLE__?.version,
          assetCount: Object.keys(window.__MOCKERY_BUNDLE__?.assets || {}).length,
          pubBrandSrc: pubHost.shadowRoot.getElementById("brand-img")?.getAttribute("src"),
          adminBrandSrc: adminHost.shadowRoot.getElementById("brand-img-2")?.getAttribute("src"),
          toastText: document.getElementById("toast")?.textContent?.trim() || "",
        };
      })()`);

      assert.equal(offlineState.bundleVersion, 2);
      assert.equal(offlineState.assetCount, 1);
      assert.equal(offlineState.pubBrandSrc, expectedBrandUri, "Runtime resolver must hydrate /assets/brand.svg");
      assert.equal(offlineState.adminBrandSrc, expectedBrandUri, "Runtime resolver must hydrate ../assets/brand.svg");
      assert.equal(offlineState.toastText, "");

      assert.deepEqual(filePage.pageErrors, [], `Exported preview.html had page errors: ${filePage.pageErrors.join("; ")}`);
      assert.deepEqual(filePage.cspErrors, [], `Exported preview.html had CSP violations: ${filePage.cspErrors.join("; ")}`);
      assert.deepEqual(filePage.consoleErrors, [], `Exported preview.html had console errors: ${filePage.consoleErrors.join("; ")}`);
    } finally {
      await filePage.close();
    }

    // -------------------------------------------------------------------------
    // 3. Adversarial XSS Defense-in-Depth Test (DOM Sanitizer + CSP block inline JS)
    // -------------------------------------------------------------------------
    fs.writeFileSync(
      pubScreenPath,
      `${origPub}
      <img id="xss-img" src="x" onerror="window.__MOCKERY_XSS__='onerror'" />
      <script>window.__MOCKERY_XSS__='script';</script>
      <a id="xss-link" href="javascript:window.__MOCKERY_XSS__='jsurl'">bad</a>`,
      "utf8"
    );
    const xssSrv = await serveMockery({ root: mockDir, port: 0 });
    try {
      const xssPage = await browser.openPage(`http://127.0.0.1:${xssSrv.port}/`);
      try {
        await xssPage.waitFor(`
          document.querySelector('#frames .frame[data-id="public-status"] .frame-screen')?.shadowRoot?.getElementById("xss-img")
        `);
        const xssState = await xssPage.evalJs(`(() => {
          const screens = [...document.querySelectorAll("#frames .frame .frame-screen")];
          const scriptTags = screens.reduce((n, h) => n + h.shadowRoot.querySelectorAll("script").length, 0);
          const pubHost = document.querySelector('#frames .frame[data-id="public-status"] .frame-screen');
          const xssImg = pubHost.shadowRoot.getElementById("xss-img");
          const xssLink = pubHost.shadowRoot.getElementById("xss-link");
          return {
            xssGlobal: window.__MOCKERY_XSS__ ?? null,
            scriptTags,
            hasOnerrorAttr: xssImg ? xssImg.hasAttribute("onerror") : false,
            hasJsHref: xssLink ? xssLink.hasAttribute("href") : false,
          };
        })()`);

        assert.equal(xssState.xssGlobal, null, "Injected XSS payloads must never execute");
        assert.equal(xssState.scriptTags, 0, "Sanitizer must strip all <script> tags");
        assert.equal(xssState.hasOnerrorAttr, false, "Sanitizer must strip onerror handlers");
        assert.equal(xssState.hasJsHref, false, "Sanitizer must strip javascript: href URLs");
        assert.deepEqual(xssPage.pageErrors, [], `XSS test had uncaught page errors: ${xssPage.pageErrors.join("; ")}`);
      } finally {
        await xssPage.close();
      }
    } finally {
      await xssSrv.close();
    }
  } finally {
    await browser.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup race
    }
  }
});
