import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeWorkspace,
  extractSystemState,
  REQUIRED_KEYS,
} from "../../skills/sf-tree/scripts/analyzer.mjs";

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Validate the golden PulseBoard pipeline fixtures (all 8 core stages + Stage 6b Mockery + PASS review)
 * and deterministic negative defect cases against sf-tree's real analyzer.mjs.
 */
export function runGoldenSchemasEval(repoRoot) {
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed, detail });
  const fixtureSrc = path.join(repoRoot, "evals", "fixtures", "pulseboard");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sf-eval-golden-"));
  try {
    const factoryDir = path.join(tmpRoot, "docs", "factory");
    copyDirRecursive(fixtureSrc, factoryDir);

    // Set strictly ascending mtimes across pipeline stages so golden pipeline has 0 staleness
    const orderedFiles = [
      "01-vision.md",
      "02-market-research.md",
      "03-brd.md",
      "04-prd.md",
      "05-ux.md",
      "06-ui.md",
      "06b-mockery.md",
      "mockups/flow.json",
      "07-architecture.md",
      "reviews/prd-vs-architecture-review.md",
      "08-specs.md",
    ];
    const baseSec = Math.floor(Date.now() / 1000) - 600;
    orderedFiles.forEach((rel, idx) => {
      const full = path.join(factoryDir, rel);
      const t = baseSec + idx * 10;
      fs.utimesSync(full, t, t);
    });

    // 1. Validate 80/20 structure and exact <system_state> schema per golden file
    for (const rel of orderedFiles.filter((f) => f.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(factoryDir, rel), "utf8");
      const { narrative, state: parsed } = extractSystemState(content);
      const hasNarrative = narrative.trim().length >= 60;
      const expectedKeys = parsed?.phase ? REQUIRED_KEYS[parsed.phase] : null;
      const missingKeys = expectedKeys
        ? expectedKeys.filter((k) => !(k in parsed))
        : ["phase"];
      add(
        `golden-schema:${rel}`,
        Boolean(parsed && hasNarrative && expectedKeys && missingKeys.length === 0),
        parsed && missingKeys.length === 0
          ? `phase="${parsed.phase}" valid JSON + narrative (${narrative.trim().length} chars)`
          : `Schema failure (missing: ${missingKeys.join(", ")})`
      );
    }

    // 2. Analyze full golden workspace via sf-tree analyzer
    const graph = analyzeWorkspace(tmpRoot);
    add(
      "golden-pipeline:core-complete",
      graph.summary.core_completed === 8 && graph.summary.core_total === 8,
      `${graph.summary.core_completed}/${graph.summary.core_total} core stages complete`
    );
    add(
      "golden-pipeline:optional-mockery",
      graph.summary.optional_completed === 1 && graph.mockery.flow_json_valid === true,
      `optional=${graph.summary.optional_completed}/1, flow_json_valid=${graph.mockery.flow_json_valid}`
    );
    add(
      "golden-pipeline:zero-invalid-or-stale",
      graph.summary.invalid_phases.length === 0 &&
        graph.summary.stale_phases.length === 0 &&
        graph.summary.failing_review_phases.length === 0,
      `invalid=${graph.summary.invalid_phases.length}, stale=${graph.summary.stale_phases.length}, fail=${graph.summary.failing_review_phases.length}`
    );
    const archNode = graph.nodes.find((n) => n.phase === "architecture");
    add(
      "golden-pipeline:review-pass",
      archNode?.status === "reviewed_pass",
      `architecture status=${archNode?.status}`
    );

    // 3. Negative case A: Malformed JSON triggers invalid_phases
    const badPath = path.join(factoryDir, "04-prd.md");
    const origPrd = fs.readFileSync(badPath, "utf8");
    fs.writeFileSync(badPath, "# Broken PRD\n\n<system_state>{ invalid json </system_state>\n");
    const badGraph = analyzeWorkspace(tmpRoot);
    add(
      "negative:malformed-json-detected",
      badGraph.summary.invalid_phases.includes("prd"),
      `invalid_phases=${JSON.stringify(badGraph.summary.invalid_phases)}`
    );
    fs.writeFileSync(badPath, origPrd);
    const prdTime = baseSec + 30;
    fs.utimesSync(badPath, prdTime, prdTime);

    // 4. Negative case B: Stale upstream edit propagates blast radius downstream
    const visionPath = path.join(factoryDir, "01-vision.md");
    const futureSec = Math.floor(Date.now() / 1000) + 120;
    fs.utimesSync(visionPath, futureSec, futureSec);
    const staleGraph = analyzeWorkspace(tmpRoot);
    add(
      "negative:stale-blast-radius-detected",
      staleGraph.summary.stale_phases.includes("prd") &&
        staleGraph.summary.stale_phases.includes("architecture") &&
        staleGraph.summary.stale_phases.includes("specs"),
      `stale_phases=${JSON.stringify(staleGraph.summary.stale_phases)}`
    );

    // Restore vision mtime
    fs.utimesSync(visionPath, baseSec, baseSec);

    // 5. Negative case C: sf-review FAIL verdict flags failing_review_phases
    const failRevPath = path.join(factoryDir, "reviews", "vision-vs-specs-review.md");
    fs.writeFileSync(
      failRevPath,
      [
        "# Red Team Fail Fixture",
        "",
        "<system_state>",
        JSON.stringify({
          phase: "review",
          source_phases: ["vision"],
          target_phase: "specs",
          verdict: "FAIL",
          critical_violations_count: 1,
          scope_creep_warnings_count: 1,
          blocking_issues: ["Introduced SAML SSO which is explicitly_out_of_scope"],
        }),
        "</system_state>",
      ].join("\n")
    );
    const failGraph = analyzeWorkspace(tmpRoot);
    add(
      "negative:review-fail-detected",
      failGraph.summary.failing_review_phases.includes("specs"),
      `failing_review_phases=${JSON.stringify(failGraph.summary.failing_review_phases)}`
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  return {
    suite: "schemas",
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    total: checks.length,
    checks,
  };
}
