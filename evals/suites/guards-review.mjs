import fs from "node:fs";
import path from "node:path";
import {
  extractSystemState,
  REQUIRED_KEYS,
} from "../../skills/sf-tree/scripts/analyzer.mjs";

const SKILL_TO_PHASE = {
  "sf-vision": "vision",
  "sf-market-research": "market-research",
  "sf-brd": "brd",
  "sf-prd": "prd",
  "sf-ux": "ux",
  "sf-ui": "ui",
  "sf-mockery": "mockery",
  "sf-architecture": "architecture",
  "sf-specs": "specs",
  "sf-review": "review",
};

const DOWNSTREAM_PIPELINE_SKILLS = [
  "sf-market-research",
  "sf-brd",
  "sf-prd",
  "sf-ux",
  "sf-ui",
  "sf-mockery",
  "sf-architecture",
  "sf-specs",
  "sf-review",
];

const PIPELINE_SKILLS_WITH_STATE = [
  "sf-vision",
  ...DOWNSTREAM_PIPELINE_SKILLS,
];

const ALL_SKILLS = [
  ...PIPELINE_SKILLS_WITH_STATE,
  "sf-tree",
  "sf-telemetry",
];

/**
 * Audit Missing-Input Guard contracts, Input Resolution Order, human-in-the-loop
 * non-auto-advance gates, parsed <system_state> key parity against REQUIRED_KEYS,
 * and sf-review Red Team audit vector completeness.
 */
export function runGuardsReviewEval(repoRoot) {
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed, detail });

  for (const skill of PIPELINE_SKILLS_WITH_STATE) {
    const content = fs.readFileSync(
      path.join(repoRoot, "skills", skill, "SKILL.md"),
      "utf8"
    );

    const expectedPhase = SKILL_TO_PHASE[skill];
    const expectedKeys = REQUIRED_KEYS[expectedPhase] || [];
    const extracted = extractSystemState(content);
    const parsed = extracted.state;
    const isValidObject = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && !extracted.error);
    const actualKeys = isValidObject ? Object.keys(parsed) : [];
    const missingKeys = expectedKeys.filter((k) => !actualKeys.includes(k));
    const extraKeys = actualKeys.filter((k) => !expectedKeys.includes(k));
    const phaseMatches = isValidObject && parsed.phase === expectedPhase;
    const stateOk = isValidObject && phaseMatches && missingKeys.length === 0 && extraKeys.length === 0;

    let stateDetail;
    if (stateOk) {
      stateDetail = `Parsed <system_state> JSON (phase="${parsed.phase}", ${actualKeys.length}/${expectedKeys.length} exact REQUIRED_KEYS)`;
    } else if (!isValidObject) {
      stateDetail = `Invalid or missing <system_state> JSON (${extracted.error || "not an object"})`;
    } else if (!phaseMatches) {
      stateDetail = `Expected phase="${expectedPhase}", got "${String(parsed.phase)}"`;
    } else {
      const parts = [];
      if (missingKeys.length) parts.push(`missing: ${missingKeys.join(", ")}`);
      if (extraKeys.length) parts.push(`extra: ${extraKeys.join(", ")}`);
      stateDetail = `<system_state> key drift vs REQUIRED_KEYS (${parts.join("; ")})`;
    }

    add(`contract-system-state:${skill}`, stateOk, stateDetail);

    const hasNoAutoAdvance = /never auto-advance|pause for human review|wait for the user/i.test(
      content
    );
    add(
      `contract-human-gate:${skill}`,
      hasNoAutoAdvance,
      hasNoAutoAdvance
        ? "Enforces human-in-the-loop pause gate"
        : "Missing explicit human-in-the-loop pause gate"
    );
  }

  for (const skill of DOWNSTREAM_PIPELINE_SKILLS) {
    const content = fs.readFileSync(
      path.join(repoRoot, "skills", skill, "SKILL.md"),
      "utf8"
    );

    const hasResolution = /Input Resolution Order/i.test(content) && /docs\/factory\//i.test(content);
    add(
      `guard-input-resolution:${skill}`,
      hasResolution,
      hasResolution
        ? "Specifies 3-step Input Resolution Order including docs/factory/"
        : "Missing Input Resolution Order"
    );

    const hasMissingGuard =
      /Missing-Input Guard/i.test(content) && /\bSTOP\b/.test(content);
    add(
      `guard-missing-input:${skill}`,
      hasMissingGuard,
      hasMissingGuard
        ? "Enforces Missing-Input Guard with explicit STOP"
        : "Missing Missing-Input Guard STOP directive"
    );
  }

  // sf-review specific adversarial vector assertions
  const reviewContent = fs.readFileSync(
    path.join(repoRoot, "skills", "sf-review", "SKILL.md"),
    "utf8"
  );
  const reviewVectors = [
    ["constraint-inheritance", /hard_constraints[\s\S]*explicitly_out_of_scope/i],
    ["scope-creep-vector", /Scope Creep/i],
    ["missing-logic-vector", /Missing required business logic|missing required logic/i],
    ["schema-parity-vector", /Schema & parity|schema\/parity/i],
    ["mockery-red-team", /Mockery Target Audit Checks/i],
    ["no-rewrite-guard", /NEVER rewrite the Target document/i],
  ];
  for (const [id, re] of reviewVectors) {
    add(
      `sf-review:${id}`,
      re.test(reviewContent),
      re.test(reviewContent) ? "Present" : `Missing vector: ${id}`
    );
  }

  // Read-only / out-of-repo guardrails on inspector & telemetry skills
  const treeContent = fs.readFileSync(
    path.join(repoRoot, "skills", "sf-tree", "SKILL.md"),
    "utf8"
  );
  add(
    "sf-tree:strictly-read-only",
    /Strictly Read-Only/i.test(treeContent) && /Zero Repo Pollution/i.test(treeContent),
    "Enforces Strictly Read-Only & Zero Repo Pollution guardrails"
  );

  const telContent = fs.readFileSync(
    path.join(repoRoot, "skills", "sf-telemetry", "SKILL.md"),
    "utf8"
  );
  add(
    "sf-telemetry:zero-idle-and-8pt-gate",
    /Zero Idle Token Overhead/i.test(telContent) && /8-Point Epic Split Gate/i.test(telContent),
    "Enforces Zero Idle Token Overhead & 8-Point Epic Split Gate"
  );

  // Prompt Quality Gate contract across all 12 skills
  for (const skill of ALL_SKILLS) {
    const content = fs.readFileSync(
      path.join(repoRoot, "skills", skill, "SKILL.md"),
      "utf8"
    );
    const hasPromptGate =
      /Prompt Quality Gate/i.test(content) &&
      /\[placeholders\]/i.test(content) &&
      /follow-up questions/i.test(content) &&
      /proceed anyway/i.test(content) &&
      /Assumptions Used/i.test(content) &&
      /never overridable/i.test(content);
    add(
      `guard-prompt-quality-gate:${skill}`,
      hasPromptGate,
      hasPromptGate
        ? "Enforces context-aware Prompt Quality Gate with placeholders, follow-ups, override disclosure, and non-overridable hard guards"
        : "Missing or incomplete Prompt Quality Gate contract"
    );
  }

  return {
    suite: "guards",
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    total: checks.length,
    checks,
  };
}
