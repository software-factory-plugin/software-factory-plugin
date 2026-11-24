import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./skills-audit.mjs";

// Conservative ~4 chars/token heuristic for deterministic offline tracking
const MAX_IDLE_TOKENS_TOTAL = 1500;
const MAX_SINGLE_SKILL_BODY_TOKENS = 3500;

function estimateTokens(str) {
  return Math.ceil(String(str || "").length / 4);
}

/**
 * Track idle router token overhead (frontmatter only) and on-demand activation
 * footprint across every skill, enforcing strict token-efficiency ceilings.
 */
export function runTokenEfficiencyEval(repoRoot) {
  const skillsDir = path.join(repoRoot, "skills");
  const skillNames = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const checks = [];
  const metrics = [];
  let totalIdleTokens = 0;
  let totalBodyTokens = 0;

  for (const name of skillNames) {
    const file = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const fm = parseFrontmatter(raw);
    const idleText = fm ? `${fm.name}: ${fm.description}` : "";
    const idleTokens = estimateTokens(idleText);
    const bodyTokens = estimateTokens(raw);

    totalIdleTokens += idleTokens;
    totalBodyTokens += bodyTokens;

    metrics.push({
      skill: name,
      idle_chars: idleText.length,
      idle_est_tokens: idleTokens,
      body_chars: raw.length,
      body_est_tokens: bodyTokens,
    });

    checks.push({
      id: `body-budget:${name}`,
      passed: bodyTokens <= MAX_SINGLE_SKILL_BODY_TOKENS,
      detail: `~${bodyTokens} est tokens (limit <= ${MAX_SINGLE_SKILL_BODY_TOKENS})`,
    });
  }

  checks.push({
    id: "idle-router-budget:total",
    passed: totalIdleTokens <= MAX_IDLE_TOKENS_TOTAL,
    detail: `~${totalIdleTokens} est idle router tokens across ${metrics.length} skills (limit <= ${MAX_IDLE_TOKENS_TOTAL})`,
  });

  return {
    suite: "tokens",
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    total: checks.length,
    summary: {
      skills_count: metrics.length,
      total_idle_est_tokens: totalIdleTokens,
      max_idle_budget_tokens: MAX_IDLE_TOKENS_TOTAL,
      total_on_demand_est_tokens: totalBodyTokens,
    },
    metrics,
    checks,
  };
}
