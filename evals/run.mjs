#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runSkillsAudit } from "./suites/skills-audit.mjs";
import { runGoldenSchemasEval } from "./suites/golden-schemas.mjs";
import { runGuardsReviewEval } from "./suites/guards-review.mjs";
import { runTokenEfficiencyEval } from "./suites/token-efficiency.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const VALID_SUITES = new Set(["all", "skills", "schemas", "guards", "tokens"]);

function printHelp() {
  process.stdout.write(
    [
      "Usage: node evals/run.mjs [options]",
      "",
      "Options:",
      "  --suite <all|skills|schemas|guards|tokens>  Select suite (default: all)",
      "  --json                                      Emit JSON report",
      "  --markdown                                  Emit Markdown summary",
      "  --ascii                                     Emit terminal ASCII report (default)",
      "  -h, --help                                  Show help",
    ].join("\n") + "\n"
  );
}

export function parseArgs(argv) {
  const opts = { suite: "all", mode: "ascii", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.mode = "json";
    } else if (arg === "--markdown") {
      opts.mode = "markdown";
    } else if (arg === "--ascii") {
      opts.mode = "ascii";
    } else if (arg === "--suite") {
      const next = argv[i + 1];
      if (!next || !VALID_SUITES.has(next)) {
        throw new Error(`Invalid --suite value "${next}" (expected all|skills|schemas|guards|tokens)`);
      }
      opts.suite = next;
      i += 1;
    } else if (arg.startsWith("--suite=")) {
      const val = arg.slice("--suite=".length);
      if (!VALID_SUITES.has(val)) {
        throw new Error(`Invalid --suite value "${val}" (expected all|skills|schemas|guards|tokens)`);
      }
      opts.suite = val;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

export function runAllEvals({ repoRoot = DEFAULT_REPO_ROOT, suite = "all" } = {}) {
  const results = [];
  if (suite === "all" || suite === "skills") results.push(runSkillsAudit(repoRoot));
  if (suite === "all" || suite === "schemas") results.push(runGoldenSchemasEval(repoRoot));
  if (suite === "all" || suite === "guards") results.push(runGuardsReviewEval(repoRoot));
  if (suite === "all" || suite === "tokens") results.push(runTokenEfficiencyEval(repoRoot));

  const passed = results.reduce((s, r) => s + r.passed, 0);
  const failed = results.reduce((s, r) => s + r.failed, 0);
  const total = results.reduce((s, r) => s + r.total, 0);

  return {
    schema_version: "1.0",
    report_type: "software-factory-evals",
    generated_at: new Date().toISOString(),
    ok: failed === 0,
    summary: { passed, failed, total },
    suites: results,
  };
}

export function formatAscii(report) {
  const lines = [
    `Software Factory Eval Suite — ${report.ok ? "PASS" : "FAIL"} (${report.summary.passed}/${report.summary.total} checks passed)`,
    "=".repeat(84),
  ];
  for (const s of report.suites) {
    lines.push(
      `[${s.failed === 0 ? "PASS" : "FAIL"}] suite=${s.suite} (${s.passed}/${s.total})`
    );
    if (s.summary && s.suite === "tokens") {
      lines.push(
        `       idle router footprint: ~${s.summary.total_idle_est_tokens}/${s.summary.max_idle_budget_tokens} est tokens across ${s.summary.skills_count} skills`
      );
    }
    for (const c of s.checks) {
      if (!c.passed) {
        lines.push(`  ✖ ${c.id}: ${c.detail}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatMarkdown(report) {
  const lines = [
    `# Software Factory Eval Report — ${report.ok ? "PASS" : "FAIL"}`,
    "",
    `- **Total Checks:** ${report.summary.passed}/${report.summary.total} passed (${report.summary.failed} failed)`,
    "",
    "| Suite | Status | Passed | Total |",
    "| :--- | :---: | :---: | :---: |",
  ];
  for (const s of report.suites) {
    lines.push(
      `| \`${s.suite}\` | ${s.failed === 0 ? "PASS" : "FAIL"} | ${s.passed} | ${s.total} |`
    );
  }
  const failing = [];
  for (const s of report.suites) {
    for (const c of s.checks || []) {
      if (!c.passed) {
        failing.push({ suite: s.suite, id: c.id, detail: c.detail });
      }
    }
  }
  if (failing.length > 0) {
    lines.push("", "## Failures", "");
    for (const f of failing) {
      lines.push(`- \`[${f.suite}] ${f.id}\`: ${f.detail}`);
    }
  }
  const tokSuite = report.suites.find((s) => s.suite === "tokens");
  if (tokSuite?.metrics) {
    lines.push(
      "",
      `## Token Footprint (~${tokSuite.summary.total_idle_est_tokens} idle router est tokens)`,
      "",
      "| Skill | Idle Est Tokens | On-Demand Body Est Tokens |",
      "| :--- | :---: | :---: |"
    );
    for (const m of tokSuite.metrics) {
      lines.push(`| \`${m.skill}\` | ~${m.idle_est_tokens} | ~${m.body_est_tokens} |`);
    }
  }
  return lines.join("\n");
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  const report = runAllEvals({ suite: opts.suite });
  if (opts.mode === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (opts.mode === "markdown") {
    process.stdout.write(formatMarkdown(report) + "\n");
  } else {
    process.stdout.write(formatAscii(report) + "\n");
  }
  process.exit(report.ok ? 0 : 1);
}
