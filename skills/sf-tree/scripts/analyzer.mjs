import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SCHEMA_VERSION = "1.0";
export const FACTORY_DIR = "docs/factory";
export const REVIEWS_DIR = "docs/factory/reviews";
export const DEFAULT_MOCKUPS_DIR = "docs/factory/mockups";
export const MTIME_TIEBREAKER_MS = 2000;

export const STAGE_DEFS = Object.freeze([
  {
    phase: "vision",
    stage: "1",
    skill: "sf-vision",
    label: "Vision & Charter",
    file: "docs/factory/01-vision.md",
    optional: false,
    requiredUpstreams: [],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
  {
    phase: "market-research",
    stage: "2",
    skill: "sf-market-research",
    label: "Market Research",
    file: "docs/factory/02-market-research.md",
    optional: false,
    requiredUpstreams: ["vision"],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
  {
    phase: "brd",
    stage: "3",
    skill: "sf-brd",
    label: "Business Requirements",
    file: "docs/factory/03-brd.md",
    optional: false,
    requiredUpstreams: ["vision", "market-research"],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
  {
    phase: "prd",
    stage: "4",
    skill: "sf-prd",
    label: "Product Requirements",
    file: "docs/factory/04-prd.md",
    optional: false,
    requiredUpstreams: ["vision", "brd"],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
  {
    phase: "ux",
    stage: "5",
    skill: "sf-ux",
    label: "UX Architecture",
    file: "docs/factory/05-ux.md",
    optional: false,
    requiredUpstreams: ["vision", "prd"],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
  {
    phase: "ui",
    stage: "6",
    skill: "sf-ui",
    label: "UI Design System",
    file: "docs/factory/06-ui.md",
    optional: false,
    requiredUpstreams: ["vision", "ux"],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
  {
    phase: "mockery",
    stage: "6b",
    skill: "sf-mockery",
    label: "Interactive Mockups",
    file: "docs/factory/06b-mockery.md",
    optional: true,
    requiredUpstreams: ["vision", "ux"],
    recommendedUpstreams: [],
    optionalUpstreams: ["ui"],
  },
  {
    phase: "architecture",
    stage: "7",
    skill: "sf-architecture",
    label: "System Architecture",
    file: "docs/factory/07-architecture.md",
    optional: false,
    requiredUpstreams: ["vision", "prd", "ux", "ui"],
    recommendedUpstreams: ["brd"],
    optionalUpstreams: ["mockery"],
  },
  {
    phase: "specs",
    stage: "8",
    skill: "sf-specs",
    label: "Agentic TDD Specs",
    file: "docs/factory/08-specs.md",
    optional: false,
    requiredUpstreams: ["vision", "prd", "architecture"],
    recommendedUpstreams: [],
    optionalUpstreams: [],
  },
]);

export const STAGE_BY_PHASE = new Map(STAGE_DEFS.map((stage) => [stage.phase, stage]));

export const EDGES = Object.freeze([
  { from: "vision", to: "market-research", kind: "required" },
  { from: "vision", to: "brd", kind: "required" },
  { from: "market-research", to: "brd", kind: "required" },
  { from: "vision", to: "prd", kind: "required" },
  { from: "brd", to: "prd", kind: "required" },
  { from: "vision", to: "ux", kind: "required" },
  { from: "prd", to: "ux", kind: "required" },
  { from: "vision", to: "ui", kind: "required" },
  { from: "ux", to: "ui", kind: "required" },
  { from: "vision", to: "mockery", kind: "optional" },
  { from: "ux", to: "mockery", kind: "optional" },
  { from: "ui", to: "mockery", kind: "optional" },
  { from: "vision", to: "architecture", kind: "required" },
  { from: "brd", to: "architecture", kind: "recommended" },
  { from: "prd", to: "architecture", kind: "required" },
  { from: "ux", to: "architecture", kind: "required" },
  { from: "ui", to: "architecture", kind: "required" },
  { from: "mockery", to: "architecture", kind: "optional" },
  { from: "vision", to: "specs", kind: "required" },
  { from: "prd", to: "specs", kind: "required" },
  { from: "architecture", to: "specs", kind: "required" },
]);

export const REQUIRED_KEYS = Object.freeze({
  vision: [
    "phase",
    "project_name",
    "primary_user",
    "ux_tone",
    "hard_constraints",
    "explicitly_out_of_scope",
  ],
  "market-research": [
    "phase",
    "competitors",
    "market_gap_defined",
    "validation_status",
    "identified_risks",
  ],
  brd: [
    "phase",
    "monetization_model",
    "core_kpis",
    "compliance_requirements",
    "budget_or_timeline_constraints",
  ],
  prd: [
    "phase",
    "core_flows",
    "business_rules",
    "required_integrations",
    "edge_case_mitigations",
  ],
  ux: [
    "phase",
    "screens_required",
    "primary_navigation_pattern",
    "key_interactions",
    "accessibility_requirements",
  ],
  ui: [
    "phase",
    "css_framework_recommendation",
    "color_palette",
    "typography",
    "border_radius_base",
  ],
  mockery: [
    "phase",
    "fidelity",
    "mockups_dir",
    "devices",
    "sections",
    "screens",
    "components",
    "edges_count",
    "tokens_synced_from_ui",
  ],
  architecture: [
    "phase",
    "frontend_stack",
    "backend_stack",
    "database_type",
    "data_models",
    "core_endpoints",
  ],
  specs: [
    "phase",
    "openapi_stubs",
    "required_unit_tests",
    "required_e2e_tests",
    "linter_rules",
  ],
  review: [
    "phase",
    "source_phases",
    "target_phase",
    "verdict",
    "critical_violations_count",
    "scope_creep_warnings_count",
    "blocking_issues",
  ],
});

const REVIEW_FILENAME_RE = /^[a-zA-Z0-9._-]+\.md$/;

/**
 * Extract the trailing <system_state>...</system_state> JSON block and narrative markdown.
 */
export function extractSystemState(markdown) {
  const source = typeof markdown === "string" ? markdown : "";
  const regex = /<system_state>([\s\S]*?)<\/system_state>/gi;
  let lastMatch = null;
  let match;
  while ((match = regex.exec(source)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return {
      found: false,
      raw: null,
      state: null,
      narrative: source.trim(),
      error: "Missing <system_state>...</system_state> block",
    };
  }

  const raw = lastMatch[1].trim();
  const narrative = (
    source.slice(0, lastMatch.index) +
    source.slice(lastMatch.index + lastMatch[0].length)
  ).trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      found: true,
      raw,
      state: null,
      narrative,
      error: `Invalid JSON in <system_state>: ${err.message}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      found: true,
      raw,
      state: null,
      narrative,
      error: "<system_state> JSON must be an object",
    };
  }

  return {
    found: true,
    raw,
    state: parsed,
    narrative,
    error: null,
  };
}

/**
 * Validate a parsed <system_state> object against the expected phase schema.
 */
export function validateSystemState(state, expectedPhase, parseError = null) {
  const errors = [];
  if (parseError) {
    errors.push(parseError);
    return { valid: false, errors };
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    errors.push("Missing or invalid <system_state> object");
    return { valid: false, errors };
  }

  if (state.phase !== expectedPhase) {
    errors.push(
      `Expected phase "${expectedPhase}", got ${JSON.stringify(state.phase)}`
    );
  }

  const requiredKeys = REQUIRED_KEYS[expectedPhase] || [];
  for (const key of requiredKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(state, key) ||
      state[key] === undefined ||
      state[key] === null
    ) {
      errors.push(`Missing required key "${key}"`);
    }
  }

  if (expectedPhase === "mockery") {
    if (
      state.fidelity !== undefined &&
      state.fidelity !== "wireframe" &&
      state.fidelity !== "styled"
    ) {
      errors.push(
        `Invalid mockery fidelity ${JSON.stringify(state.fidelity)} (expected "wireframe" or "styled")`
      );
    }
    if (
      state.tokens_synced_from_ui !== undefined &&
      typeof state.tokens_synced_from_ui !== "boolean"
    ) {
      errors.push(`"tokens_synced_from_ui" must be a boolean`);
    }
  }

  if (expectedPhase === "review") {
    if (state.verdict !== "PASS" && state.verdict !== "FAIL") {
      errors.push(
        `Invalid review verdict ${JSON.stringify(state.verdict)} (expected "PASS" or "FAIL")`
      );
    }
    if (!Array.isArray(state.source_phases)) {
      errors.push(`"source_phases" must be an array`);
    }
    if (typeof state.target_phase !== "string" || !state.target_phase.trim()) {
      errors.push(`"target_phase" must be a non-empty string`);
    }
    if (!Array.isArray(state.blocking_issues)) {
      errors.push(`"blocking_issues" must be an array`);
    }
    if (typeof state.critical_violations_count !== "number") {
      errors.push(`"critical_violations_count" must be a number`);
    }
    if (typeof state.scope_creep_warnings_count !== "number") {
      errors.push(`"scope_creep_warnings_count" must be a number`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function createGitTimeResolver(workspaceRoot) {
  let isGitRepo = null;
  let dirtyFiles = null;
  const commitTimeCache = new Map();

  function ensureGitChecked() {
    if (isGitRepo !== null) return isGitRepo;
    try {
      const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      isGitRepo = out === "true";
    } catch {
      isGitRepo = false;
    }
    return isGitRepo;
  }

  function getDirtyFiles() {
    if (dirtyFiles !== null) return dirtyFiles;
    dirtyFiles = new Set();
    if (!ensureGitChecked()) return dirtyFiles;
    try {
      const out = execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=all", "--", FACTORY_DIR],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      for (const line of out.split(/\r?\n/)) {
        if (!line || line.length < 4) continue;
        let rel = line.slice(3).trim();
        if (rel.includes(" -> ")) {
          rel = rel.split(" -> ").pop().trim();
        }
        if (rel.startsWith('"') && rel.endsWith('"')) {
          rel = rel.slice(1, -1);
        }
        dirtyFiles.add(rel.replaceAll("\\", "/"));
      }
    } catch {
      // Ignore git status failures and treat as no dirty info.
    }
    return dirtyFiles;
  }

  return function getGitTimeMs(relPath) {
    const normalized = relPath.replaceAll("\\", "/");
    if (commitTimeCache.has(normalized)) {
      return commitTimeCache.get(normalized);
    }
    if (!ensureGitChecked()) {
      commitTimeCache.set(normalized, null);
      return null;
    }
    if (getDirtyFiles().has(normalized)) {
      commitTimeCache.set(normalized, null);
      return null;
    }
    try {
      const out = execFileSync(
        "git",
        ["log", "-1", "--format=%ct", "--", normalized],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim();
      if (!out || !/^\d+$/.test(out)) {
        commitTimeCache.set(normalized, null);
        return null;
      }
      const ms = Number(out) * 1000;
      commitTimeCache.set(normalized, ms);
      return ms;
    } catch {
      commitTimeCache.set(normalized, null);
      return null;
    }
  };
}

/**
 * Compare whether fileA is strictly newer than fileB using mtimeMs with a
 * 2000ms git commit-timestamp tiebreaker.
 */
function compareFileFreshness(fileA, fileB, getGitTimeMs) {
  if (
    !fileA ||
    !fileB ||
    typeof fileA.mtime_ms !== "number" ||
    typeof fileB.mtime_ms !== "number"
  ) {
    return { aNewer: false, source: "mtime" };
  }

  const diff = Math.abs(fileA.mtime_ms - fileB.mtime_ms);
  if (diff <= MTIME_TIEBREAKER_MS) {
    const gitA = getGitTimeMs(fileA.file);
    const gitB = getGitTimeMs(fileB.file);
    if (typeof gitA === "number" && typeof gitB === "number") {
      fileA.effective_time_ms = gitA;
      fileA.time_source = "git";
      fileB.effective_time_ms = gitB;
      fileB.time_source = "git";
      return { aNewer: gitA > gitB, source: "git" };
    }
  }

  return { aNewer: fileA.mtime_ms > fileB.mtime_ms, source: "mtime" };
}

function safeStat(absPath) {
  try {
    const st = fs.statSync(absPath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function isPathInside(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + path.sep)
  );
}

function sanitizeMockupsDir(workspaceRoot, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return DEFAULT_MOCKUPS_DIR;
  }
  const trimmed = candidate.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  const absFactory = path.resolve(workspaceRoot, FACTORY_DIR);
  const absCandidate = path.resolve(workspaceRoot, trimmed);
  if (!isPathInside(absFactory, absCandidate)) {
    return DEFAULT_MOCKUPS_DIR;
  }
  return path.relative(workspaceRoot, absCandidate).replaceAll("\\", "/");
}

function analyzeMockery(workspaceRoot, mockeryNode) {
  const manifestExists = mockeryNode.exists;
  const state = mockeryNode.state_valid ? mockeryNode.system_state : null;
  const mockupsDir = sanitizeMockupsDir(
    workspaceRoot,
    state ? state.mockups_dir : DEFAULT_MOCKUPS_DIR
  );
  const absMockupsDir = path.resolve(workspaceRoot, mockupsDir);
  const absFlowJson = path.join(absMockupsDir, "flow.json");
  const flowStat = safeStat(absFlowJson);
  const flowJsonExists = Boolean(flowStat);

  let flowJsonValid = false;
  let flowData = null;
  const parityWarnings = [];

  if (flowJsonExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(absFlowJson, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        flowJsonValid = true;
        flowData = parsed;
      } else {
        parityWarnings.push("flow.json must contain a JSON object");
      }
    } catch (err) {
      parityWarnings.push(`flow.json contains invalid JSON: ${err.message}`);
    }
  }

  const flowNodes = flowData
    ? Array.isArray(flowData.nodes)
      ? flowData.nodes
      : Array.isArray(flowData.screens)
        ? flowData.screens
        : []
    : [];
  const flowEdges = flowData && Array.isArray(flowData.edges) ? flowData.edges : [];
  const flowSections =
    flowData && Array.isArray(flowData.sections) ? flowData.sections : [];

  let diskComponents = [];
  const absComponentsDir = path.join(absMockupsDir, "components");
  try {
    if (fs.existsSync(absComponentsDir) && fs.statSync(absComponentsDir).isDirectory()) {
      diskComponents = fs
        .readdirSync(absComponentsDir)
        .filter((f) => f.endsWith(".html"))
        .map((f) => f.replace(/\.html$/, ""))
        .sort();
    }
  } catch {
    diskComponents = [];
  }

  if (manifestExists && state) {
    if (!flowJsonExists) {
      parityWarnings.push(
        `flow.json parity drift: ${mockupsDir}/flow.json is missing while ${mockeryNode.file} exists`
      );
    } else if (flowJsonValid) {
      const stateScreens = Array.isArray(state.screens) ? state.screens : [];
      if (stateScreens.length !== flowNodes.length) {
        parityWarnings.push(
          `flow.json parity drift: 06b-mockery.md lists ${stateScreens.length} screens, flow.json has ${flowNodes.length}`
        );
      } else {
        const stateIds = stateScreens
          .map((s) => (s && typeof s === "object" ? s.id : String(s)))
          .filter(Boolean)
          .sort();
        const flowIds = flowNodes
          .map((n) => (n && typeof n === "object" ? n.id : String(n)))
          .filter(Boolean)
          .sort();
        if (JSON.stringify(stateIds) !== JSON.stringify(flowIds)) {
          parityWarnings.push(
            "flow.json parity drift: screen IDs differ between 06b-mockery.md and flow.json"
          );
        }
      }

      if (
        typeof state.edges_count === "number" &&
        state.edges_count !== flowEdges.length
      ) {
        parityWarnings.push(
          `flow.json parity drift: 06b-mockery.md edges_count is ${state.edges_count}, flow.json has ${flowEdges.length}`
        );
      }

      const stateSections = Array.isArray(state.sections) ? state.sections : [];
      if (stateSections.length !== flowSections.length) {
        parityWarnings.push(
          `flow.json parity drift: 06b-mockery.md lists ${stateSections.length} sections, flow.json has ${flowSections.length}`
        );
      }

      const stateComponents = Array.isArray(state.components) ? state.components : [];
      if (
        diskComponents.length > 0 &&
        stateComponents.length !== diskComponents.length
      ) {
        parityWarnings.push(
          `flow.json parity drift: 06b-mockery.md lists ${stateComponents.length} components, ${mockupsDir}/components/ has ${diskComponents.length}`
        );
      }

      for (const node of flowNodes) {
        if (node && typeof node.file === "string" && node.file.trim()) {
          const targetScreen = path.resolve(absMockupsDir, node.file);
          if (!isPathInside(absMockupsDir, targetScreen) || !safeStat(targetScreen)) {
            parityWarnings.push(
              `flow.json parity drift: referenced screen file "${node.file}" does not exist under ${mockupsDir}`
            );
          }
        }
      }
    }
  } else if (!manifestExists && flowJsonExists) {
    parityWarnings.push(
      `flow.json exists at ${mockupsDir}/flow.json without ${mockeryNode.file} manifest`
    );
  }

  const screensCount = state && Array.isArray(state.screens)
    ? state.screens.length
    : flowNodes.length;
  const componentsCount = state && Array.isArray(state.components)
    ? state.components.length
    : diskComponents.length;
  const edgesCount =
    state && typeof state.edges_count === "number"
      ? state.edges_count
      : flowEdges.length;

  return {
    manifest_exists: manifestExists,
    mockups_dir: mockupsDir,
    flow_json_exists: flowJsonExists,
    flow_json_valid: flowJsonValid,
    fidelity:
      state && (state.fidelity === "wireframe" || state.fidelity === "styled")
        ? state.fidelity
        : null,
    tokens_synced_from_ui:
      state && typeof state.tokens_synced_from_ui === "boolean"
        ? state.tokens_synced_from_ui
        : null,
    screens_count: screensCount,
    components_count: componentsCount,
    edges_count: edgesCount,
    parity_warnings: parityWarnings,
    viewer_command: `npx mockery ${mockupsDir}`,
    check_command: `npx mockery check ${mockupsDir}`,
  };
}

function readAllReviews(workspaceRoot) {
  const absReviewsDir = path.resolve(workspaceRoot, REVIEWS_DIR);
  if (!fs.existsSync(absReviewsDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(absReviewsDir);
  } catch {
    return [];
  }

  const reviews = [];
  for (const name of entries.sort()) {
    if (!REVIEW_FILENAME_RE.test(name)) continue;
    const absPath = path.join(absReviewsDir, name);
    const st = safeStat(absPath);
    if (!st) continue;
    const relPath = `${REVIEWS_DIR}/${name}`;
    const rawMarkdown = fs.readFileSync(absPath, "utf8");
    const extracted = extractSystemState(rawMarkdown);
    const validation = validateSystemState(
      extracted.state,
      "review",
      extracted.error
    );
    if (!validation.valid) {
      continue;
    }

    const s = extracted.state;
    reviews.push({
      file: relPath,
      source_phases: s.source_phases.map((p) => String(p)),
      target_phase: String(s.target_phase),
      verdict: s.verdict,
      critical_violations_count: s.critical_violations_count,
      scope_creep_warnings_count: s.scope_creep_warnings_count,
      blocking_issues: s.blocking_issues.map((b) => String(b)),
      mtime_ms: Math.round(st.mtimeMs),
      effective_time_ms: Math.round(st.mtimeMs),
      time_source: "mtime",
      is_stale: false,
      stale_reasons: [],
    });
  }
  return reviews;
}

function buildNextPrompt(node, stageDef, nodeByPhase, allNodes) {
  const formatFileList = (phases) =>
    phases
      .map((p) => STAGE_BY_PHASE.get(p)?.file)
      .filter(Boolean)
      .join(", ");

  const existingUpstreamPhases = [
    ...stageDef.requiredUpstreams,
    ...stageDef.recommendedUpstreams,
    ...stageDef.optionalUpstreams,
  ].filter((p) => {
    const up = nodeByPhase.get(p);
    return up && up.exists && up.state_valid;
  });

  if (node.status === "locked") {
    const missing = stageDef.requiredUpstreams.filter((p) => {
      const up = nodeByPhase.get(p);
      return !up || !up.exists || !up.state_valid;
    });
    return `Complete required upstream artifacts first (${formatFileList(missing)}), then run ${stageDef.skill}.`;
  }

  if (node.status === "unlocked") {
    if (node.phase === "vision") {
      return `Use sf-vision to create ${node.file} with our project's core thesis, target user, UX tone, hard constraints, and explicitly out-of-scope boundaries.`;
    }
    if (node.phase === "mockery") {
      const uiNode = nodeByPhase.get("ui");
      const mode = uiNode && uiNode.exists && uiNode.state_valid ? "styled" : "wireframe";
      return `Use sf-mockery (${mode} mode) with ${formatFileList(existingUpstreamPhases)} to generate ${node.file} and ${DEFAULT_MOCKUPS_DIR}/.`;
    }
    return `Use ${stageDef.skill} with ${formatFileList(existingUpstreamPhases)} to produce ${node.file}.`;
  }

  if (node.status === "invalid") {
    const errs = node.state_errors.join("; ");
    return `Repair the malformed <system_state> JSON block in ${node.file} (${errs}) so it satisfies the ${stageDef.skill} schema.`;
  }

  const latestReview = node.reviews[0] || null;

  if (node.status === "reviewed_fail") {
    const issues =
      latestReview && latestReview.blocking_issues.length > 0
        ? ` (${latestReview.blocking_issues.join("; ")})`
        : "";
    const sources =
      latestReview && latestReview.source_phases.length > 0
        ? formatFileList(latestReview.source_phases)
        : formatFileList(existingUpstreamPhases);
    const staleNote = node.is_stale
      ? " and reconcile newer upstream changes"
      : "";
    return `Fix the blocking issues in ${node.file}${issues}${staleNote}, then re-run sf-review comparing ${sources || "upstream artifacts"} against ${node.file}.`;
  }

  if (node.is_stale) {
    const reasons = node.stale_reasons.join("; ");
    const sources = formatFileList(existingUpstreamPhases);
    if (
      node.phase === "mockery" &&
      node.system_state?.fidelity === "wireframe" &&
      nodeByPhase.get("ui")?.exists
    ) {
      return `Re-run sf-mockery in styled mode using ${sources} to restyle ${DEFAULT_MOCKUPS_DIR}/ and update ${node.file}, then run sf-review.`;
    }
    return `Reconcile ${node.file} with updated upstream artifacts (${reasons}), then run sf-review comparing ${sources || "upstream artifacts"} against ${node.file}.`;
  }

  if (node.status === "unreviewed") {
    if (node.phase === "vision") {
      return `Confirm ${node.file} with stakeholders, then run sf-market-research using ${node.file} to produce docs/factory/02-market-research.md.`;
    }
    const sources = formatFileList(existingUpstreamPhases);
    return `Run sf-review comparing ${sources} against ${node.file} to validate upstream constraints, scope, and <system_state> parity.`;
  }

  if (latestReview && latestReview.is_stale) {
    const sources =
      latestReview.source_phases.length > 0
        ? formatFileList(latestReview.source_phases)
        : formatFileList(existingUpstreamPhases);
    return `Re-run sf-review comparing ${sources || "upstream artifacts"} against ${node.file} because the previous review (${latestReview.file}) is stale.`;
  }

  const nextUnlocked = allNodes.find(
    (n) => !n.optional && n.status === "unlocked"
  );
  if (nextUnlocked) {
    return `${node.file} passed review and is up to date. Next unlocked stage: ${nextUnlocked.skill} (${nextUnlocked.file}).`;
  }
  return `${node.file} passed review and is up to date.`;
}

/**
 * Analyze a consumer workspace's docs/factory/ directory and emit Graph JSON v1.
 */
export function analyzeWorkspace(workspaceRoot = process.cwd(), options = {}) {
  const absRoot = path.resolve(workspaceRoot);
  const getGitTimeMs = createGitTimeResolver(absRoot);

  // 1. Read and parse all 9 canonical stage files.
  const nodes = STAGE_DEFS.map((stageDef) => {
    const absFile = path.resolve(absRoot, stageDef.file);
    const st = safeStat(absFile);

    if (!st) {
      return {
        phase: stageDef.phase,
        stage: stageDef.stage,
        skill: stageDef.skill,
        label: stageDef.label,
        file: stageDef.file,
        optional: stageDef.optional,
        exists: false,
        status: "locked",
        mtime_ms: null,
        effective_time_ms: null,
        time_source: null,
        state_valid: false,
        state_errors: [],
        system_state: null,
        is_stale: false,
        stale_reasons: [],
        warnings: [],
        reviews: [],
        next_prompt: "",
      };
    }

    const rawMarkdown = fs.readFileSync(absFile, "utf8");
    const extracted = extractSystemState(rawMarkdown);
    const validation = validateSystemState(
      extracted.state,
      stageDef.phase,
      extracted.error
    );
    const mtimeMs = Math.round(st.mtimeMs);

    return {
      phase: stageDef.phase,
      stage: stageDef.stage,
      skill: stageDef.skill,
      label: stageDef.label,
      file: stageDef.file,
      optional: stageDef.optional,
      exists: true,
      status: validation.valid ? "unreviewed" : "invalid",
      mtime_ms: mtimeMs,
      effective_time_ms: mtimeMs,
      time_source: "mtime",
      state_valid: validation.valid,
      state_errors: validation.errors,
      system_state: validation.valid ? extracted.state : null,
      is_stale: false,
      stale_reasons: [],
      warnings: [],
      reviews: [],
      next_prompt: "",
    };
  });

  const nodeByPhase = new Map(nodes.map((n) => [n.phase, n]));

  // 2. Parse and attach reviews from docs/factory/reviews/*.md.
  const allReviews = readAllReviews(absRoot);
  for (const review of allReviews) {
    const targetNode = nodeByPhase.get(review.target_phase);
    if (!targetNode) continue;

    // Check review staleness against target artifact and source_phases.
    if (targetNode.exists) {
      const cmp = compareFileFreshness(targetNode, review, getGitTimeMs);
      if (cmp.aNewer) {
        review.is_stale = true;
        review.stale_reasons.push(
          `Target ${targetNode.file} is newer than review (${cmp.source})`
        );
      }
    }
    for (const srcPhase of review.source_phases) {
      const srcNode = nodeByPhase.get(srcPhase);
      if (srcNode && srcNode.exists) {
        const cmp = compareFileFreshness(srcNode, review, getGitTimeMs);
        if (cmp.aNewer) {
          review.is_stale = true;
          review.stale_reasons.push(
            `Source ${srcNode.file} is newer than review (${cmp.source})`
          );
        }
      }
    }

    targetNode.reviews.push(review);
  }

  // Sort each node's reviews newest-first (with git tiebreaker + deterministic filename fallback).
  for (const node of nodes) {
    if (node.reviews.length > 1) {
      node.reviews.sort((a, b) => {
        const cmpAB = compareFileFreshness(a, b, getGitTimeMs);
        if (cmpAB.aNewer) return -1;
        const cmpBA = compareFileFreshness(b, a, getGitTimeMs);
        if (cmpBA.aNewer) return 1;
        return b.file.localeCompare(a.file);
      });
    }
  }

  // 3. Determine primary status for each node.
  for (const stageDef of STAGE_DEFS) {
    const node = nodeByPhase.get(stageDef.phase);
    if (!node.exists) {
      const allRequiredReady = stageDef.requiredUpstreams.every((upPhase) => {
        const up = nodeByPhase.get(upPhase);
        return Boolean(up && up.exists && up.state_valid);
      });
      node.status = allRequiredReady ? "unlocked" : "locked";
    } else if (!node.state_valid) {
      node.status = "invalid";
    } else if (node.reviews.length === 0) {
      node.status = "unreviewed";
    } else {
      const latest = node.reviews[0];
      node.status = latest.verdict === "PASS" ? "reviewed_pass" : "reviewed_fail";
    }
  }

  // 4. Compute artifact staleness & transitive downstream blast radius in topological order.
  for (const stageDef of STAGE_DEFS) {
    const node = nodeByPhase.get(stageDef.phase);
    if (!node.exists) continue;

    const stalenessParents = [...stageDef.requiredUpstreams];
    if (stageDef.phase === "mockery") {
      const uiNode = nodeByPhase.get("ui");
      if (uiNode && uiNode.exists) {
        stalenessParents.push("ui");
      }
    }

    for (const parentPhase of stalenessParents) {
      const parent = nodeByPhase.get(parentPhase);
      if (!parent || !parent.exists) continue;

      if (!parent.state_valid) {
        node.is_stale = true;
        node.stale_reasons.push(
          `Upstream ${parent.file} has invalid <system_state>`
        );
      } else if (parent.is_stale) {
        node.is_stale = true;
        node.stale_reasons.push(
          `Upstream ${parent.file} is stale (transitive blast radius)`
        );
      }

      const cmp = compareFileFreshness(parent, node, getGitTimeMs);
      if (cmp.aNewer) {
        node.is_stale = true;
        if (
          stageDef.phase === "mockery" &&
          parentPhase === "ui" &&
          node.system_state?.fidelity === "wireframe"
        ) {
          node.stale_reasons.push(
            `Upstream ${parent.file} is newer than wireframe ${node.file} (${cmp.source}) — restyle ready`
          );
        } else {
          node.stale_reasons.push(
            `Upstream ${parent.file} is newer than ${node.file} (${cmp.source})`
          );
        }
      }
    }
  }

  // 5. Analyze Stage 6b Mockery & flow.json parity.
  const mockeryNode = nodeByPhase.get("mockery");
  const mockerySummary = analyzeMockery(absRoot, mockeryNode);

  // 6. Compute semantic warnings.
  const mrNode = nodeByPhase.get("market-research");
  if (
    mrNode.exists &&
    mrNode.state_valid &&
    typeof mrNode.system_state?.validation_status === "string" &&
    mrNode.system_state.validation_status.toLowerCase().includes("pivot required")
  ) {
    mrNode.warnings.push(
      "Pivot Required: market-research validation_status flagged Pivot Required — confirm direction before advancing to sf-brd"
    );
  }

  const uiNode = nodeByPhase.get("ui");
  if (mockeryNode.exists && mockeryNode.state_valid) {
    if (
      mockeryNode.system_state.fidelity === "wireframe" &&
      uiNode.exists &&
      uiNode.state_valid
    ) {
      mockeryNode.warnings.push(
        "wireframe_ready_for_restyle: docs/factory/06-ui.md exists while 06b-mockery.md is in wireframe mode — re-run sf-mockery to sync UI tokens"
      );
    }
    if (
      mockeryNode.system_state.fidelity === "styled" &&
      mockeryNode.system_state.tokens_synced_from_ui === false
    ) {
      mockeryNode.warnings.push(
        "tokens_not_synced: 06b-mockery.md fidelity is styled but tokens_synced_from_ui is false"
      );
    }
  }
  for (const pw of mockerySummary.parity_warnings) {
    mockeryNode.warnings.push(pw);
  }

  const archNode = nodeByPhase.get("architecture");
  const brdNode = nodeByPhase.get("brd");
  if (
    (archNode.exists || archNode.status === "unlocked") &&
    (!brdNode.exists || !brdNode.state_valid)
  ) {
    archNode.warnings.push(
      "missing_recommended_brd: docs/factory/03-brd.md is missing (recommended upstream for sf-architecture)"
    );
  }

  // 7. Strip internal review helper fields to match v1 Graph JSON contract cleanly.
  for (const node of nodes) {
    node.reviews = node.reviews.map((r) => ({
      file: r.file,
      source_phases: r.source_phases,
      target_phase: r.target_phase,
      verdict: r.verdict,
      critical_violations_count: r.critical_violations_count,
      scope_creep_warnings_count: r.scope_creep_warnings_count,
      blocking_issues: r.blocking_issues,
      mtime_ms: r.mtime_ms,
      is_stale: r.is_stale,
      stale_reasons: r.stale_reasons,
    }));
  }

  // 8. Generate state-aware next_prompt strings.
  for (const stageDef of STAGE_DEFS) {
    const node = nodeByPhase.get(stageDef.phase);
    node.next_prompt = buildNextPrompt(node, stageDef, nodeByPhase, nodes);
  }

  // 9. Build project summary & top-level payload.
  const visionNode = nodeByPhase.get("vision");
  const projectName =
    visionNode.exists &&
    visionNode.state_valid &&
    typeof visionNode.system_state?.project_name === "string" &&
    visionNode.system_state.project_name.trim()
      ? visionNode.system_state.project_name.trim()
      : path.basename(absRoot);

  const coreNodes = nodes.filter((n) => !n.optional);
  const optionalNodes = nodes.filter((n) => n.optional);

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: options.generatedAt || new Date().toISOString(),
    workspace_root: absRoot,
    factory_dir: FACTORY_DIR,
    project_name: projectName,
    summary: {
      core_total: coreNodes.length,
      core_completed: coreNodes.filter((n) => n.exists && n.state_valid).length,
      optional_completed: optionalNodes.filter((n) => n.exists && n.state_valid)
        .length,
      unlocked_phases: nodes
        .filter((n) => n.status === "unlocked")
        .map((n) => n.phase),
      stale_phases: nodes.filter((n) => n.is_stale).map((n) => n.phase),
      failing_review_phases: nodes
        .filter((n) => n.status === "reviewed_fail")
        .map((n) => n.phase),
      invalid_phases: nodes
        .filter((n) => n.status === "invalid")
        .map((n) => n.phase),
    },
    nodes,
    edges: EDGES.map((e) => ({ ...e })),
    mockery: mockerySummary,
  };
}

/**
 * Read a single allowlisted stage artifact for /api/artifact/:phase.
 */
export function readArtifactDetail(workspaceRoot, phase) {
  const stageDef = STAGE_BY_PHASE.get(phase);
  if (!stageDef) {
    return null;
  }
  const absRoot = path.resolve(workspaceRoot);
  const absFile = path.resolve(absRoot, stageDef.file);
  if (!isPathInside(path.resolve(absRoot, FACTORY_DIR), absFile)) {
    return null;
  }

  const st = safeStat(absFile);
  if (!st) {
    return {
      phase: stageDef.phase,
      file: stageDef.file,
      exists: false,
      narrative_markdown: "",
      system_state: null,
      raw_markdown: "",
    };
  }

  const rawMarkdown = fs.readFileSync(absFile, "utf8");
  const extracted = extractSystemState(rawMarkdown);
  return {
    phase: stageDef.phase,
    file: stageDef.file,
    exists: true,
    narrative_markdown: extracted.narrative,
    system_state: extracted.state,
    raw_markdown: rawMarkdown,
  };
}

/**
 * Read a single allowlisted review markdown file under docs/factory/reviews/.
 * Rejects any path traversal, invalid filename, or symlink escaping reviews dir.
 */
export function readReviewDetail(workspaceRoot, filename) {
  if (
    typeof filename !== "string" ||
    !REVIEW_FILENAME_RE.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return { error: "invalid_filename", status: 400 };
  }

  const absRoot = path.resolve(workspaceRoot);
  const absReviewsDir = path.resolve(absRoot, REVIEWS_DIR);
  const absTarget = path.resolve(absReviewsDir, filename);

  if (!isPathInside(absReviewsDir, absTarget) || absTarget === absReviewsDir) {
    return { error: "invalid_filename", status: 400 };
  }

  let lstat;
  try {
    lstat = fs.lstatSync(absTarget);
  } catch {
    return { error: "not_found", status: 404 };
  }
  if (!lstat.isFile()) {
    return { error: "not_found", status: 404 };
  }

  try {
    const realReviews = fs.realpathSync(absReviewsDir);
    const realTarget = fs.realpathSync(absTarget);
    if (!isPathInside(realReviews, realTarget)) {
      return { error: "invalid_filename", status: 400 };
    }
  } catch {
    return { error: "not_found", status: 404 };
  }

  const rawMarkdown = fs.readFileSync(absTarget, "utf8");
  const extracted = extractSystemState(rawMarkdown);
  return {
    status: 200,
    data: {
      filename,
      file: `${REVIEWS_DIR}/${filename}`,
      exists: true,
      narrative_markdown: extracted.narrative,
      system_state: extracted.state,
      raw_markdown: rawMarkdown,
    },
  };
}
