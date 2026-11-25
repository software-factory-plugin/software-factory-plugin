import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { posixShellQuote } from "../../../lib/cli-utils.mjs";
import {
  isPathInside,
  resolveContainedPath,
  safeStatContainedFile,
  readContainedFile,
} from "../../../lib/fs-safe.mjs";
import {
  REQUIRED_KEYS,
  extractSystemState,
  validateSystemState,
} from "./analyzer-schema.mjs";
import {
  createSyncGitTimeResolver,
  createAsyncGitTimeResolver,
} from "./analyzer-git.mjs";

export { REQUIRED_KEYS, extractSystemState, validateSystemState };

const BUNDLED_MOCKERY_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../sf-mockery/scripts/cli.mjs"
);
const SAFE_MOCKUPS_DIR_RE = /^[a-zA-Z0-9._/-]+$/;
const IGNORED_REVIEW_ENTRIES = new Set([".DS_Store", ".gitkeep", "Thumbs.db"]);

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

// Derive EDGES programmatically from STAGE_DEFS (single source of truth).
export const EDGES = Object.freeze(
  STAGE_DEFS.flatMap((stage) => [
    ...stage.requiredUpstreams.map((from) =>
      Object.freeze({ from, to: stage.phase, kind: "required" })
    ),
    ...stage.recommendedUpstreams.map((from) =>
      Object.freeze({ from, to: stage.phase, kind: "recommended" })
    ),
    ...stage.optionalUpstreams.map((from) =>
      Object.freeze({ from, to: stage.phase, kind: "optional" })
    ),
  ])
);

const REVIEW_FILENAME_RE = /^[a-zA-Z0-9._-]+\.md$/;

function formatFreshnessSource(sourceA, sourceB) {
  if (!sourceA && !sourceB) return "mtime";
  if (sourceA === sourceB || !sourceB) return sourceA || "mtime";
  if (!sourceA) return sourceB;
  return `${sourceA}/${sourceB}`;
}

function isStrictlyNewer(entryA, entryB) {
  if (
    !entryA ||
    !entryB ||
    typeof entryA.effective_time_ms !== "number" ||
    typeof entryB.effective_time_ms !== "number"
  ) {
    return false;
  }
  return entryA.effective_time_ms > entryB.effective_time_ms;
}

export function sanitizeMockupsDir(workspaceRoot, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return DEFAULT_MOCKUPS_DIR;
  }
  const trimmed = candidate.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.startsWith("/") || !SAFE_MOCKUPS_DIR_RE.test(trimmed)) {
    return DEFAULT_MOCKUPS_DIR;
  }
  const segments = trimmed.split("/");
  if (segments.some((seg) => seg === "" || seg === "..")) {
    return DEFAULT_MOCKUPS_DIR;
  }
  const absRoot = path.resolve(workspaceRoot);
  const absFactory = path.resolve(absRoot, FACTORY_DIR);
  const absCandidate = path.resolve(absRoot, trimmed);
  if (!isPathInside(absFactory, absCandidate)) {
    return DEFAULT_MOCKUPS_DIR;
  }
  const normalized = path.relative(absRoot, absCandidate).replaceAll("\\", "/");
  if (!SAFE_MOCKUPS_DIR_RE.test(normalized)) {
    return DEFAULT_MOCKUPS_DIR;
  }
  return normalized;
}

function resolveMockeryCliInvocation() {
  try {
    if (fs.existsSync(BUNDLED_MOCKERY_CLI) && fs.statSync(BUNDLED_MOCKERY_CLI).isFile()) {
      return {
        available: true,
        prefix: `node ${posixShellQuote(BUNDLED_MOCKERY_CLI)}`,
      };
    }
  } catch {
    // fall through to clean fallback
  }
  return {
    available: false,
    prefix: "node <sf-mockery-skill-dir>/scripts/cli.mjs",
  };
}

function analyzeMockery(workspaceRoot, mockeryNode) {
  const manifestExists = mockeryNode.exists;
  const state = mockeryNode.state_valid ? mockeryNode.system_state : null;
  const mockupsDir = sanitizeMockupsDir(
    workspaceRoot,
    state ? state.mockups_dir : DEFAULT_MOCKUPS_DIR
  );
  const absMockupsDir = path.resolve(workspaceRoot, mockupsDir);
  const flowRelPath = `${mockupsDir}/flow.json`;
  const flowRead = readContainedFile(workspaceRoot, flowRelPath);
  const flowJsonExists = flowRead.ok;
  const flowMtimeMs = flowJsonExists && flowRead.stat ? Math.round(flowRead.stat.mtimeMs) : null;

  let flowJsonValid = false;
  let flowData = null;
  const parityWarnings = [];

  if (flowJsonExists) {
    try {
      const parsed = JSON.parse(flowRead.content);
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
  const compDirRes = resolveContainedPath(workspaceRoot, `${mockupsDir}/components`, {
    allowBase: false,
    allowSymlinks: false,
    requireFile: false,
  });
  try {
    if (compDirRes.ok && compDirRes.stat && compDirRes.stat.isDirectory()) {
      diskComponents = fs
        .readdirSync(compDirRes.realPath)
        .filter(
          (f) =>
            f.endsWith(".html") &&
            Boolean(safeStatContainedFile(workspaceRoot, path.join(compDirRes.absPath, f)))
        )
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
          if (
            !isPathInside(absMockupsDir, targetScreen) ||
            !safeStatContainedFile(workspaceRoot, targetScreen)
          ) {
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

  const screensCount =
    state && Array.isArray(state.screens) ? state.screens.length : flowNodes.length;
  const componentsCount =
    state && Array.isArray(state.components)
      ? state.components.length
      : diskComponents.length;
  const edgesCount =
    state && typeof state.edges_count === "number"
      ? state.edges_count
      : flowEdges.length;

  const cliInfo = resolveMockeryCliInvocation();
  const quotedMockupsDir = posixShellQuote(mockupsDir);

  return {
    summary: {
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
      mockery_cli_available: cliInfo.available,
      viewer_command: `${cliInfo.prefix} serve ${quotedMockupsDir}`,
      check_command: `${cliInfo.prefix} check ${quotedMockupsDir}`,
      export_command: `${cliInfo.prefix} export ${quotedMockupsDir}`,
    },
    flowFile: flowJsonExists
      ? { file: flowRelPath, mtime_ms: flowMtimeMs }
      : null,
  };
}

function readAllReviews(workspaceRoot) {
  const warnings = [];
  const dirRes = resolveContainedPath(workspaceRoot, REVIEWS_DIR, {
    allowBase: false,
    allowSymlinks: false,
    requireFile: false,
  });
  if (!dirRes.ok) {
    if (dirRes.reason !== "not_found") {
      warnings.push(`Skipped unsafe reviews directory ${REVIEWS_DIR} (${dirRes.reason})`);
    }
    return { reviews: [], warnings };
  }
  if (!dirRes.stat || !dirRes.stat.isDirectory()) {
    return { reviews: [], warnings };
  }

  let entries;
  try {
    entries = fs.readdirSync(dirRes.realPath);
  } catch {
    return { reviews: [], warnings };
  }

  const reviews = [];
  for (const name of entries.sort()) {
    if (IGNORED_REVIEW_ENTRIES.has(name)) continue;

    if (!REVIEW_FILENAME_RE.test(name)) {
      warnings.push(
        `Unrecognized review file in ${REVIEWS_DIR}: "${name}" (expected [a-zA-Z0-9._-]+.md)`
      );
      continue;
    }

    const relPath = `${REVIEWS_DIR}/${name}`;
    const fileRes = readContainedFile(workspaceRoot, relPath);
    if (!fileRes.ok) {
      warnings.push(
        `Skipped unreadable or unsafe review file ${relPath} (${fileRes.reason})`
      );
      continue;
    }

    const st = fileRes.stat;
    const rawMarkdown = fileRes.content;
    const extracted = extractSystemState(rawMarkdown);
    const validation = validateSystemState(
      extracted.state,
      "review",
      extracted.error
    );
    if (!validation.valid) {
      warnings.push(
        `Invalid review file ${relPath}: ${validation.errors.join("; ")}`
      );
      continue;
    }

    const s = extracted.state;
    const mtimeMs = Math.round(st.mtimeMs);
    reviews.push({
      file: relPath,
      source_phases: s.source_phases.map((p) => String(p)),
      target_phase: String(s.target_phase),
      verdict: s.verdict,
      critical_violations_count: s.critical_violations_count,
      scope_creep_warnings_count: s.scope_creep_warnings_count,
      blocking_issues: s.blocking_issues.map((b) => String(b)),
      mtime_ms: mtimeMs,
      effective_time_ms: mtimeMs,
      time_source: "mtime",
      is_stale: false,
      stale_reasons: [],
    });
  }
  return { reviews, warnings };
}

/**
 * Group a node's newest-first sorted reviews by canonical `(source_phases, target_phase)` key,
 * returning the latest effective verdict for each distinct audit pair.
 */
function getEffectiveReviews(sortedReviews) {
  const byPair = new Map();
  for (const rev of sortedReviews) {
    const srcKey = [...new Set(rev.source_phases)].sort().join(",");
    const pairKey = `${srcKey}->${rev.target_phase}`;
    if (!byPair.has(pairKey)) {
      byPair.set(pairKey, rev);
    }
  }
  return [...byPair.values()];
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

  const effectiveReviews = getEffectiveReviews(node.reviews);
  const failingReview =
    effectiveReviews.find((r) => r.verdict === "FAIL") || node.reviews[0] || null;
  const staleReview =
    effectiveReviews.find((r) => r.is_stale) || node.reviews[0] || null;

  if (node.status === "reviewed_fail") {
    const issues =
      failingReview && failingReview.blocking_issues.length > 0
        ? ` (${failingReview.blocking_issues.join("; ")})`
        : "";
    const sources =
      failingReview && failingReview.source_phases.length > 0
        ? formatFileList(failingReview.source_phases)
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

  if (node.status === "review_stale" || (staleReview && staleReview.is_stale)) {
    const sources =
      staleReview && staleReview.source_phases.length > 0
        ? formatFileList(staleReview.source_phases)
        : formatFileList(existingUpstreamPhases);
    const revFile = staleReview ? staleReview.file : "previous review";
    return `Re-run sf-review comparing ${sources || "upstream artifacts"} against ${node.file} because the previous review (${revFile}) is stale.`;
  }

  const nextUnlocked = allNodes.find(
    (n) => !n.optional && n.status === "unlocked"
  );
  if (nextUnlocked) {
    return `${node.file} passed review and is up to date. Next unlocked stage: ${nextUnlocked.skill} (${nextUnlocked.file}).`;
  }
  return `${node.file} passed review and is up to date.`;
}

function readStageNodes(absRoot) {
  return STAGE_DEFS.map((stageDef) => {
    const fileRes = readContainedFile(absRoot, stageDef.file);

    if (!fileRes.ok) {
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
        review_stale: false,
        warnings: [],
        reviews: [],
        next_prompt: "",
      };
    }

    const st = fileRes.stat;
    const rawMarkdown = fileRes.content;
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
      review_stale: false,
      warnings: [],
      reviews: [],
      next_prompt: "",
    };
  });
}

function finalizeWorkspaceGraph({
  absRoot,
  nodes,
  allReviews,
  reviewWarnings,
  mockerySummary,
  flowFreshness,
  options,
}) {
  const nodeByPhase = new Map(nodes.map((n) => [n.phase, n]));
  const topWarnings = [...reviewWarnings];

  // 1. Attach reviews and evaluate review staleness against canonical scalar timestamps.
  for (const review of allReviews) {
    const targetNode = nodeByPhase.get(review.target_phase);
    if (!targetNode) {
      topWarnings.push(
        `Review file ${review.file} targets unknown phase "${review.target_phase}"`
      );
      continue;
    }

    if (targetNode.exists) {
      if (isStrictlyNewer(targetNode, review)) {
        review.is_stale = true;
        review.stale_reasons.push(
          `Target ${targetNode.file} is newer than review (${formatFreshnessSource(targetNode.time_source, review.time_source)})`
        );
      }
      if (
        targetNode.phase === "mockery" &&
        flowFreshness &&
        isStrictlyNewer(flowFreshness, review)
      ) {
        review.is_stale = true;
        review.stale_reasons.push(
          `Target ${flowFreshness.file} is newer than review (${formatFreshnessSource(flowFreshness.time_source, review.time_source)})`
        );
      }
    }

    for (const srcPhase of review.source_phases) {
      const srcNode = nodeByPhase.get(srcPhase);
      if (srcNode && srcNode.exists) {
        if (isStrictlyNewer(srcNode, review)) {
          review.is_stale = true;
          review.stale_reasons.push(
            `Source ${srcNode.file} is newer than review (${formatFreshnessSource(srcNode.time_source, review.time_source)})`
          );
        }
        if (
          srcPhase === "mockery" &&
          flowFreshness &&
          isStrictlyNewer(flowFreshness, review)
        ) {
          review.is_stale = true;
          review.stale_reasons.push(
            `Source ${flowFreshness.file} is newer than review (${formatFreshnessSource(flowFreshness.time_source, review.time_source)})`
          );
        }
      }
    }

    targetNode.reviews.push(review);
  }

  // 2. Sort each node's reviews newest-first using strict weak ordering (no node mutation).
  for (const node of nodes) {
    if (node.reviews.length > 1) {
      node.reviews.sort((a, b) => {
        if (b.effective_time_ms !== a.effective_time_ms) {
          return b.effective_time_ms - a.effective_time_ms;
        }
        return b.file.localeCompare(a.file);
      });
    }
  }

  // 3. Determine primary status per node, aggregating verdicts per (source_phases, target_phase)
  //    so a newer PASS against one upstream never masks an unresolved FAIL against another.
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
      const effectiveReviews = getEffectiveReviews(node.reviews);
      const hasActiveFail = effectiveReviews.some((r) => r.verdict === "FAIL");
      if (hasActiveFail) {
        node.status = "reviewed_fail";
        node.review_stale = false;
      } else {
        const hasStalePass = effectiveReviews.some((r) => r.is_stale);
        if (hasStalePass) {
          node.status = "review_stale";
          node.review_stale = true;
        } else {
          node.status = "reviewed_pass";
          node.review_stale = false;
        }
      }
    }
  }

  // 4. Compute artifact staleness & transitive downstream blast radius in topological order,
  //    including required, recommended, and optional upstreams plus mockups/flow.json freshness.
  for (const stageDef of STAGE_DEFS) {
    const node = nodeByPhase.get(stageDef.phase);
    if (!node.exists) continue;

    const stalenessParents = [
      ...stageDef.requiredUpstreams,
      ...stageDef.recommendedUpstreams,
      ...stageDef.optionalUpstreams,
    ];

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

      let effectiveParent = parent;
      if (
        parentPhase === "mockery" &&
        flowFreshness &&
        isStrictlyNewer(flowFreshness, parent)
      ) {
        effectiveParent = flowFreshness;
      }

      if (isStrictlyNewer(effectiveParent, node)) {
        const srcLabel = formatFreshnessSource(
          effectiveParent.time_source,
          node.time_source
        );
        node.is_stale = true;
        if (
          stageDef.phase === "mockery" &&
          parentPhase === "ui" &&
          node.system_state?.fidelity === "wireframe"
        ) {
          node.stale_reasons.push(
            `Upstream ${effectiveParent.file} is newer than wireframe ${node.file} (${srcLabel}) — restyle ready`
          );
        } else {
          node.stale_reasons.push(
            `Upstream ${effectiveParent.file} is newer than ${node.file} (${srcLabel})`
          );
        }
      }
    }
  }

  // 5. Compute semantic warnings.
  const mrNode = nodeByPhase.get("market-research");
  if (
    mrNode.exists &&
    mrNode.state_valid &&
    mrNode.system_state?.validation_status === "Pivot Required"
  ) {
    mrNode.warnings.push(
      "Pivot Required: market-research validation_status flagged Pivot Required — confirm direction before advancing to sf-brd"
    );
  }

  const mockeryNode = nodeByPhase.get("mockery");
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

  // 6. Strip internal review helper fields to match v1 Graph JSON contract cleanly.
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
      effective_time_ms: r.effective_time_ms,
      time_source: r.time_source,
      is_stale: r.is_stale,
      stale_reasons: r.stale_reasons,
    }));
  }

  // 7. Generate state-aware next_prompt strings.
  for (const stageDef of STAGE_DEFS) {
    const node = nodeByPhase.get(stageDef.phase);
    node.next_prompt = buildNextPrompt(node, stageDef, nodeByPhase, nodes);
  }

  // 8. Build project summary & top-level payload.
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
    warnings: topWarnings,
    summary: {
      core_total: coreNodes.length,
      core_completed: coreNodes.filter((n) => n.exists && n.state_valid).length,
      optional_completed: optionalNodes.filter((n) => n.exists && n.state_valid)
        .length,
      unlocked_phases: nodes
        .filter((n) => n.status === "unlocked")
        .map((n) => n.phase),
      stale_phases: nodes.filter((n) => n.is_stale).map((n) => n.phase),
      stale_review_phases: nodes
        .filter((n) => n.review_stale)
        .map((n) => n.phase),
      failing_review_phases: nodes
        .filter((n) => n.status === "reviewed_fail")
        .map((n) => n.phase),
      invalid_phases: nodes
        .filter((n) => n.status === "invalid")
        .map((n) => n.phase),
      warnings: topWarnings,
    },
    nodes,
    edges: EDGES.map((e) => ({ ...e })),
    mockery: mockerySummary,
  };
}

/**
 * Synchronously analyze a consumer workspace's docs/factory/ directory and emit Graph JSON v1.
 */
export function analyzeWorkspace(workspaceRoot = process.cwd(), options = {}) {
  const absRoot = path.resolve(workspaceRoot);
  const gitResolver = createSyncGitTimeResolver(absRoot, FACTORY_DIR);

  const nodes = readStageNodes(absRoot);
  const { reviews: allReviews, warnings: reviewWarnings } = readAllReviews(absRoot);
  const mockeryNode = nodes.find((n) => n.phase === "mockery");
  const { summary: mockerySummary, flowFile } = analyzeMockery(absRoot, mockeryNode);

  // Compute canonical scalar freshness timestamp upfront for every existing artifact, review, and flow.json.
  for (const node of nodes) {
    if (!node.exists) continue;
    const f = gitResolver.resolveCanonicalFreshness(node.file, node.mtime_ms);
    node.effective_time_ms = f.effective_time_ms;
    node.time_source = f.time_source;
  }
  for (const rev of allReviews) {
    const f = gitResolver.resolveCanonicalFreshness(rev.file, rev.mtime_ms);
    rev.effective_time_ms = f.effective_time_ms;
    rev.time_source = f.time_source;
  }
  let flowFreshness = null;
  if (flowFile && typeof flowFile.mtime_ms === "number") {
    const f = gitResolver.resolveCanonicalFreshness(flowFile.file, flowFile.mtime_ms);
    flowFreshness = {
      file: flowFile.file,
      mtime_ms: flowFile.mtime_ms,
      effective_time_ms: f.effective_time_ms,
      time_source: f.time_source,
    };
  }

  return finalizeWorkspaceGraph({
    absRoot,
    nodes,
    allReviews,
    reviewWarnings,
    mockerySummary,
    flowFreshness,
    options,
  });
}

/**
 * Asynchronously analyze a consumer workspace's docs/factory/ directory using non-blocking
 * memoized git subprocesses (used by server.mjs broadcasts & API endpoints).
 */
export async function analyzeWorkspaceAsync(
  workspaceRoot = process.cwd(),
  options = {}
) {
  const absRoot = path.resolve(workspaceRoot);
  const gitResolver = createAsyncGitTimeResolver(absRoot, FACTORY_DIR);

  const nodes = readStageNodes(absRoot);
  const { reviews: allReviews, warnings: reviewWarnings } = readAllReviews(absRoot);
  const mockeryNode = nodes.find((n) => n.phase === "mockery");
  const { summary: mockerySummary, flowFile } = analyzeMockery(absRoot, mockeryNode);

  const tasks = [];
  for (const node of nodes) {
    if (!node.exists) continue;
    tasks.push(
      gitResolver.resolveCanonicalFreshness(node.file, node.mtime_ms).then((f) => {
        node.effective_time_ms = f.effective_time_ms;
        node.time_source = f.time_source;
      })
    );
  }
  for (const rev of allReviews) {
    tasks.push(
      gitResolver.resolveCanonicalFreshness(rev.file, rev.mtime_ms).then((f) => {
        rev.effective_time_ms = f.effective_time_ms;
        rev.time_source = f.time_source;
      })
    );
  }

  let flowFreshness = null;
  if (flowFile && typeof flowFile.mtime_ms === "number") {
    tasks.push(
      gitResolver.resolveCanonicalFreshness(flowFile.file, flowFile.mtime_ms).then((f) => {
        flowFreshness = {
          file: flowFile.file,
          mtime_ms: flowFile.mtime_ms,
          effective_time_ms: f.effective_time_ms,
          time_source: f.time_source,
        };
      })
    );
  }

  await Promise.all(tasks);

  return finalizeWorkspaceGraph({
    absRoot,
    nodes,
    allReviews,
    reviewWarnings,
    mockerySummary,
    flowFreshness,
    options,
  });
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

  const fileRes = readContainedFile(absRoot, stageDef.file);
  if (!fileRes.ok) {
    if (fileRes.reason === "not_found") {
      return {
        phase: stageDef.phase,
        file: stageDef.file,
        exists: false,
        narrative_markdown: "",
        system_state: null,
        raw_markdown: "",
      };
    }
    return null;
  }

  const rawMarkdown = fileRes.content;
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
 * Rejects any path traversal, invalid filename, or symlink escaping workspace/reviews dir.
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
  const relPath = `${REVIEWS_DIR}/${filename}`;
  const res = resolveContainedPath(absRoot, relPath, {
    allowBase: false,
    allowSymlinks: false,
    requireFile: true,
  });

  if (!res.ok) {
    if (res.reason === "not_found" || res.reason === "not_a_file") {
      return { error: "not_found", status: 404 };
    }
    return { error: "invalid_filename", status: 400 };
  }

  const rawMarkdown = fs.readFileSync(res.realPath, "utf8");
  const extracted = extractSystemState(rawMarkdown);
  return {
    status: 200,
    data: {
      filename,
      file: relPath,
      exists: true,
      narrative_markdown: extracted.narrative,
      system_state: extracted.state,
      raw_markdown: rawMarkdown,
    },
  };
}
