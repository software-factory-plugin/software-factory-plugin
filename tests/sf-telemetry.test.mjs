import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TELEMETRY_SCHEMA_VERSION,
  appendTelemetryRecords,
  normalizeTelemetryRecord,
  readTelemetryStore,
  resolveDefaultStorePath,
  totalInputTokens,
  totalTokens,
  validateStorePath,
} from "../skills/sf-telemetry/scripts/schema.mjs";
import {
  PRICING_TABLE_UPDATED,
  estimateCostDetails,
  loadPricingTable,
  lookupModelPricing,
  normalizeModelId,
  validatePricingEntry,
} from "../skills/sf-telemetry/scripts/pricing.mjs";
import {
  parseBootstrapComment,
  parseBootstrapExport,
  parseTranscriptJsonl,
} from "../skills/sf-telemetry/scripts/parsers.mjs";
import {
  buildCalibrationReport,
  formatLinearTelemetryComment,
  formatReportMarkdown,
} from "../skills/sf-telemetry/scripts/calibrator.mjs";
import { parseCliArgs } from "../skills/sf-telemetry/scripts/cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "skills", "sf-telemetry", "scripts", "cli.mjs");

function makeTempDir(prefix = "sf-telemetry-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("schema v2 validates non-overlapping token fields, rejects v1 and bad numerics/executions", () => {
  assert.equal(TELEMETRY_SCHEMA_VERSION, "2.0");

  const rec = normalizeTelemetryRecord({
    issue_id: "SOF-46",
    model: "claude-sonnet-4.6",
    estimate_points: 3,
    felt_points: 5,
    uncached_input_tokens: "10,000",
    cache_read_tokens: 50000,
    cache_write_tokens: 4000,
    output_tokens: 2500,
    cost_usd: "$1.25",
    execution: "minor-rework",
    review_verdict: "pass",
    source_ref: "transcript:sha256:abc123",
  });

  assert.equal(rec.schema_version, "2.0");
  assert.equal(rec.execution, "minor_rework");
  assert.equal(rec.rework_count, 1);
  assert.equal(rec.review_verdict, "PASS");
  assert.equal(rec.cost_usd, 1.25);
  assert.equal(totalInputTokens(rec), 64000);
  assert.equal(totalTokens(rec), 66500);

  // Rejects legacy v1
  assert.throws(
    () => normalizeTelemetryRecord({ schema_version: "1.0", issue_id: "SOF-1", estimate_points: 2 }),
    /Unsupported schema_version/
  );

  // Rejects whitespace-only, dollar-only, negative, and unknown execution values
  for (const badCost of ["", "   ", "$", "$-1", "-0.5", "free"]) {
    assert.throws(
      () => normalizeTelemetryRecord({ issue_id: "SOF-1", estimate_points: 2, cost_usd: badCost }),
      /Invalid cost_usd/
    );
  }
  assert.throws(
    () => normalizeTelemetryRecord({ issue_id: "SOF-1", estimate_points: 2, uncached_input_tokens: "   " }),
    /Invalid uncached_input_tokens/
  );
  assert.throws(
    () => normalizeTelemetryRecord({ issue_id: "SOF-1", estimate_points: 2, execution: "chaotic" }),
    /Invalid execution/
  );
  assert.equal(
    normalizeTelemetryRecord({ issue_id: "SOF-1", estimate_points: 1, execution: "first-pass" }).execution,
    "smooth"
  );
});

test("pricing engine uses specificity ordering, boundary matching, cacheWritePer1M, and strict validation", () => {
  assert.match(PRICING_TABLE_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(normalizeModelId("Gemini_2.5  Flash-Lite"), "gemini-2.5-flash-lite");

  // Specific variants must not be shadowed by shorter prefixes
  const gpt4oMini = lookupModelPricing("gpt-4o-mini-2025-01");
  assert.equal(gpt4oMini.match, "gpt-4o-mini");
  assert.equal(gpt4oMini.inputPer1M, 0.15);
  const gpt4o = lookupModelPricing("gpt-4o");
  assert.equal(gpt4o.match, "gpt-4o");
  assert.notEqual(gpt4o.inputPer1M, gpt4oMini.inputPer1M);

  const o3Pro = lookupModelPricing("o3_pro_high");
  assert.equal(o3Pro.match, "o3-pro");
  assert.equal(o3Pro.inputPer1M, 20.0);
  const o3Base = lookupModelPricing("o3");
  assert.equal(o3Base.match, "o3");
  assert.notEqual(o3Base.inputPer1M, o3Pro.inputPer1M);

  const gpt41Nano = lookupModelPricing("gpt-4.1-nano");
  assert.equal(gpt41Nano.match, "gpt-4.1-nano");
  const gpt41 = lookupModelPricing("gpt-4.1");
  assert.equal(gpt41.match, "gpt-4.1");
  assert.notEqual(gpt41.inputPer1M, gpt41Nano.inputPer1M);

  const gemini4 = lookupModelPricing("gemini-4-neon");
  assert.equal(gemini4.match, "gemini-4");

  // Word-boundary prevents substring false match ("demo3" must NOT match "o3")
  assert.equal(lookupModelPricing("demo3"), null);
  assert.equal(lookupModelPricing("demo3-custom"), null);

  // Anthropic cacheWritePer1M accounting
  const claudeCost = estimateCostDetails({
    model: "claude-sonnet-4-6",
    uncached_input_tokens: 1_000_000,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  // 3.0 + 0.3 + 3.75 + 15.0 = 22.05
  assert.equal(claudeCost.cost_usd, 22.05);
  assert.equal(claudeCost.fallback_used, false);
  assert.deepEqual(claudeCost.warnings, []);

  // Unknown model emits explicit fallback warning
  const unknownCost = estimateCostDetails({
    model: "mystery-model-9000",
    uncached_input_tokens: 5000,
    output_tokens: 1000,
  });
  assert.equal(unknownCost.cost_usd, null);
  assert.equal(unknownCost.fallback_used, true);
  assert.equal(unknownCost.warnings.length, 1);

  // Strict validation rejects NaN, negative, Infinity, string rates
  assert.throws(() => validatePricingEntry({ match: "x", inputPer1M: -1, outputPer1M: 1 }), /Invalid pricing rate/);
  assert.throws(() => validatePricingEntry({ match: "x", inputPer1M: Number.NaN, outputPer1M: 1 }), /Invalid pricing rate/);
  assert.throws(() => validatePricingEntry({ match: "x", inputPer1M: 1, outputPer1M: "5" }), /Invalid pricing rate/);
  assert.throws(() => validatePricingEntry({ match: "x", inputPer1M: 1, outputPer1M: 2, cacheWritePer1M: Infinity }), /Invalid pricing rate/);

  // SF_TELEMETRY_PRICING override loads cleanly
  const dir = makeTempDir();
  try {
    const pricingFile = path.join(dir, "custom-pricing.json");
    fs.writeFileSync(
      pricingFile,
      JSON.stringify({ "mystery-model-9000": { inputPer1M: 10, cacheReadPer1M: 1, cacheWritePer1M: 12, outputPer1M: 30 } }),
      "utf8"
    );
    const table = loadPricingTable(null, { env: { SF_TELEMETRY_PRICING: pricingFile }, homedir: dir });
    const custom = lookupModelPricing("mystery-model-9000", table);
    assert.equal(custom.inputPer1M, 10);
    assert.equal(custom.cacheWritePer1M, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTranscriptJsonl streams 4 harness formats, deduplicates message.id/requestId chunks, prices multi-model breakdown, and reports malformed lines", async () => {
  const dir = makeTempDir();
  try {
    const transcriptPath = path.join(dir, "mixed-session.jsonl");
    const lines = [
      // Malformed JSON line
      "{broken-json",
      // 1. Gemini (inclusive promptTokenCount=10000, cached=6000 -> uncached=4000; candidates=500 + thoughts=1500 -> output=2000)
      JSON.stringify({
        timestamp: "2026-11-24T10:00:00Z",
        model: "gemini-2.5-pro",
        usageMetadata: {
          promptTokenCount: 10000,
          cachedContentTokenCount: 6000,
          candidatesTokenCount: 500,
          thoughtsTokenCount: 1500,
        },
      }),
      // 2. Anthropic streaming chunks with same message.id (must keep final maximal usage, NOT sum both!)
      JSON.stringify({
        timestamp: "2026-11-24T10:01:00Z",
        message: {
          id: "msg_stream_1",
          model: "claude-sonnet-4.6",
          usage: { input_tokens: 2000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, output_tokens: 50 },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-24T10:01:05Z",
        message: {
          id: "msg_stream_1",
          model: "claude-sonnet-4.6",
          usage: { input_tokens: 2000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, output_tokens: 800 },
        },
      }),
      // 3. OpenAI Chat Completions with duplicate requestId streaming update (prompt_tokens=8000 includes cached=3000 -> uncached=5000)
      JSON.stringify({
        timestamp: "2026-11-24T10:02:00Z",
        requestId: "req_oai_1",
        model: "gpt-4o-mini",
        usage: {
          prompt_tokens: 8000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-24T10:02:02Z",
        requestId: "req_oai_1",
        model: "gpt-4o-mini",
        usage: {
          prompt_tokens: 8000,
          completion_tokens: 400,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
      }),
      // 4. Codex cumulative + duplicate snapshot (duplicate must be ignored; delta on next turn summed cleanly)
      JSON.stringify({
        timestamp: "2026-11-24T10:03:00Z",
        model: "codex-mini",
        payload: {
          info: {
            total_token_usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 300 },
            last_token_usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 300 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-24T10:03:01Z",
        model: "codex-mini",
        payload: {
          info: {
            total_token_usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 300 },
            last_token_usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 300 },
          },
        },
      }),
      // Final timestamp
      JSON.stringify({
        timestamp: "2026-11-24T10:05:30Z",
        event: "session_end",
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

    const parsed = await parseTranscriptJsonl(transcriptPath, {
      issueId: "SOF-46",
      estimatePoints: 5,
      feltPoints: 5,
    });

    assert.equal(parsed.skipped_lines, 1);
    assert.ok(parsed.warnings.some((w) => w.includes("Skipped malformed JSON")));
    assert.equal(parsed.record.recorded_at, "2026-11-24T10:05:30.000Z");
    assert.match(parsed.record.source_ref, /^transcript:sha256:[0-9a-f]{64}$/);

    // Zero double-billing across all 4 harnesses:
    // Gemini (4000/6000/0/2000) + Anthropic (2000/5000/1000/800) + OpenAI (5000/3000/0/400) + Codex (3000/1000/0/300)
    assert.equal(parsed.record.uncached_input_tokens, 14000);
    assert.equal(parsed.record.cache_read_tokens, 15000);
    assert.equal(parsed.record.cache_write_tokens, 1000);
    assert.equal(parsed.record.output_tokens, 3500);
    assert.equal(parsed.record.model_breakdown.length, 4);

    // Verify per-model breakdown cost sum matches total cost_usd
    const expectedSum =
      Math.round(parsed.record.model_breakdown.reduce((acc, b) => acc + b.cost_usd, 0) * 1e6) / 1e6;
    assert.equal(parsed.record.cost_usd, expectedSum);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storage enforces hashed filenames, out-of-repo/git-root/symlink guards, 0o700/0o600 modes, stale-lock recovery, lenient reads, and atomic source_ref upsert", () => {
  const dir = makeTempDir();
  try {
    // 1. Hashed default store path disambiguates identical basenames
    const wsA = path.join(dir, "org-a", "app");
    const wsB = path.join(dir, "org-b", "app");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    const prevEnv = process.env.SF_TELEMETRY_STORE;
    delete process.env.SF_TELEMETRY_STORE;
    try {
      const storeA = resolveDefaultStorePath(wsA);
      const storeB = resolveDefaultStorePath(wsB);
      assert.match(path.basename(storeA), /^app-[0-9a-f]{8}\.jsonl$/);
      assert.notEqual(storeA, storeB);
    } finally {
      if (prevEnv !== undefined) process.env.SF_TELEMETRY_STORE = prevEnv;
    }

    // 2. Path hygiene guards (inside workspace / git-root, non-.jsonl, symlink)
    assert.throws(
      () => validateStorePath(path.join(REPO_ROOT, "telemetry.jsonl"), { workspaceRoot: REPO_ROOT }),
      /outside the workspace/
    );
    assert.throws(
      () => validateStorePath(path.join(REPO_ROOT, "telemetry.jsonl"), { workspaceRoot: path.join(REPO_ROOT, "skills") }),
      /outside/i
    );
    assert.throws(
      () => validateStorePath(path.join(dir, "not-jsonl.txt"), { workspaceRoot: wsA }),
      /must end with "\.jsonl"/
    );
    const realStore = path.join(dir, "store-dir", "real.jsonl");
    const symStore = path.join(dir, "sym.jsonl");
    fs.mkdirSync(path.dirname(realStore), { recursive: true });
    fs.writeFileSync(realStore, "", "utf8");
    fs.symlinkSync(realStore, symStore);
    assert.throws(
      () => validateStorePath(symStore, { workspaceRoot: wsA }),
      /symlink/
    );

    // 3. Permissions (0o700 dir / 0o600 file) + stale lock recovery + trailing newline safety
    const privateDir = path.join(dir, "private-telemetry");
    const storePath = path.join(privateDir, "records.jsonl");
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: 999999, timestamp: Date.now() - 60_000 }) + "\n",
      "utf8"
    );
    const firstRec = normalizeTelemetryRecord({
      issue_id: "SOF-10",
      estimate_points: 2,
      felt_points: 2,
      model: "claude-sonnet-4.6",
      source_ref: "linear-comment:c-10",
      cost_usd: 0.25,
    });
    fs.writeFileSync(storePath, JSON.stringify(firstRec), "utf8"); // intentionally no trailing newline

    const secondRec = normalizeTelemetryRecord({
      issue_id: "SOF-11",
      estimate_points: 3,
      felt_points: 3,
      model: "claude-sonnet-4.6",
      source_ref: "linear-comment:c-11",
      cost_usd: 0.5,
    });
    const appendRes = appendTelemetryRecords(storePath, [secondRec], {
      deduplicate: false,
      workspaceRoot: wsA,
    });
    assert.equal(appendRes.written, 1);
    assert.equal(fs.existsSync(`${storePath}.lock`), false);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
    }

    // 4. Atomic source_ref upsert replaces existing record in-place without duplicating
    const updatedFirst = { ...firstRec, felt_points: 3, cost_usd: 0.42 };
    const upsertRes = appendTelemetryRecords(storePath, [updatedFirst, secondRec], {
      deduplicate: true,
      upsert: true,
      workspaceRoot: wsA,
    });
    assert.equal(upsertRes.updated, 1);
    assert.equal(upsertRes.skipped, 1);
    assert.equal(upsertRes.written, 0);

    const readAfter = readTelemetryStore(storePath, { workspaceRoot: wsA });
    assert.equal(readAfter.records.length, 2);
    assert.equal(readAfter.records[0].felt_points, 3);
    assert.equal(readAfter.records[0].cost_usd, 0.42);

    // 5. Lenient vs strict read on corrupt line
    fs.appendFileSync(storePath, "{corrupt json line\n", "utf8");
    const lenient = readTelemetryStore(storePath, { lenient: true, workspaceRoot: wsA });
    assert.equal(lenient.records.length, 2);
    assert.equal(lenient.skipped_lines, 1);
    assert.equal(lenient.warnings.length, 1);

    assert.throws(
      () => readTelemetryStore(storePath, { lenient: false, workspaceRoot: wsA }),
      /invalid JSON/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Linear comment & GraphQL bootstrap parsers handle currency edge cases, heading bounds, cache-only roundtrip, and UUID rejection", () => {
  const body = [
    "### Telemetry (Track #4 Bootstrap)",
    "- **Model:** Claude Sonnet 4.6",
    "- **Estimate vs. Felt Size:** 3 pts -> 5 pts",
    "- **Tokens / Cost:** $1,200.50 in total",
    "- **Execution:** minor-rework — fixed parser regex",
    "",
    "## Unrelated Follow-up Notes",
    "- **Model:** wrong-model-from-later-section",
    "- **Execution:** blocked — should be ignored",
  ].join("\n");

  const rec = parseBootstrapComment(body, { issueId: "SOF-47", commentId: "cmt-1" });
  assert.equal(rec.model, "Claude Sonnet 4.6");
  assert.equal(rec.cost_usd, 1200.5);
  assert.equal(rec.uncached_input_tokens, null);
  assert.equal(rec.execution, "minor_rework");
  assert.equal(rec.notes, "fixed parser regex");
  assert.equal(rec.source_ref, "linear-comment:cmt-1");

  // "$1.50 in total" must NOT parse "1.50 in" as tokens
  const smallTotal = parseBootstrapComment(
    [
      "### Telemetry",
      "- **Model:** gpt-4o-mini",
      "- **Estimate vs. Felt Size:** 2 pts -> 2 pts",
      "- **Tokens / Cost:** $1.50 in total",
      "- **Execution:** smooth",
    ].join("\n"),
    { issueId: "SOF-48A" }
  );
  assert.equal(smallTotal.cost_usd, 1.5);
  assert.equal(smallTotal.uncached_input_tokens, null);

  // "n/a · $0.45" parses cost cleanly
  const costOnlyBody = [
    "### Telemetry (Track #4 Bootstrap)",
    "- **Model:** gpt-4o-mini",
    "- **Estimate vs. Felt Size:** 2 pts -> 2 pts",
    "- **Tokens / Cost:** n/a · $0.45",
    "- **Execution:** smooth",
  ].join("\n");
  const costOnly = parseBootstrapComment(costOnlyBody, { issueId: "SOF-48" });
  assert.equal(costOnly.cost_usd, 0.45);
  assert.equal(costOnly.uncached_input_tokens, null);

  // Cache-only comment formatting & round-trip
  const cacheOnlyRec = normalizeTelemetryRecord({
    issue_id: "SOF-49",
    model: "claude-sonnet-4.6",
    estimate_points: 1,
    felt_points: 1,
    cache_read_tokens: 45000,
    cache_write_tokens: 5000,
    cost_usd: 0.0323,
    execution: "smooth",
  });
  const formatted = formatLinearTelemetryComment(cacheOnlyRec);
  assert.match(formatted, /45,000 cache read/);
  assert.match(formatted, /5,000 cache write/);
  const roundTripped = parseBootstrapComment(formatted, { issueId: "SOF-49" });
  assert.equal(roundTripped.cache_read_tokens, 45000);
  assert.equal(roundTripped.cache_write_tokens, 5000);

  // GraphQL comments.nodes + per-comment error isolation + UUID rejection
  const gqlExport = {
    data: {
      issues: {
        nodes: [
          {
            identifier: "SOF-50",
            project: { id: "P-SOF-7" },
            comments: {
              nodes: [
                {
                  id: "cmt-good",
                  createdAt: "2026-11-24T12:00:00Z",
                  body: formatted,
                },
                {
                  id: "cmt-bad",
                  createdAt: "2026-11-24T12:01:00Z",
                  body: "### Telemetry\n- **Estimate vs. Felt Size:** 99 pts -> 99 pts\n",
                },
              ],
            },
          },
          {
            id: "11111111-2222-3333-4444-555555555555",
            comments: { nodes: [{ id: "cmt-orphan", body: formatted }] },
          },
        ],
      },
    },
  };
  const exported = parseBootstrapExport(gqlExport);
  assert.equal(exported.records.length, 1);
  assert.equal(exported.records[0].issue_id, "SOF-50");
  assert.equal(exported.records[0].source_ref, "linear-comment:cmt-good");
  assert.equal(exported.warnings.length, 2);
});

test("calibrator enforces weighted calibration_ratio, Fibonacci scope_blowup, n>=5 stratified cost_outlier, repricing, filters, and GFM escaping", () => {
  const makeRec = (overrides) =>
    normalizeTelemetryRecord({
      issue_id: "SOF-X",
      project_id: "P-SOF-7",
      phase: "architecture",
      model: "claude-sonnet-4.6",
      estimate_points: 2,
      felt_points: 2,
      uncached_input_tokens: 10000,
      output_tokens: 2000,
      cost_usd: 0.1,
      execution: "smooth",
      review_verdict: "PASS",
      recorded_at: "2026-11-24T10:00:00Z",
      ...overrides,
    });

  // 4 samples in stratum (2, claude-sonnet-4.6) -> NO cost_outlier even for 15x cost!
  const smallSet = [
    makeRec({ issue_id: "SOF-1", cost_usd: 0.1 }),
    makeRec({ issue_id: "SOF-2", cost_usd: 0.1 }),
    makeRec({ issue_id: "SOF-3", cost_usd: 0.1 }),
    makeRec({ issue_id: "SOF-4", cost_usd: 1.5 }),
  ];
  const smallReport = buildCalibrationReport(smallSet);
  assert.equal(smallReport.alerts.filter((a) => a.kind === "cost_outlier").length, 0);

  // Add 5th sample -> stratum reaches n=5, cost_outlier MUST trigger on SOF-4
  // Also test scope_blowup: 1 -> 3 (+2 Fib steps = blowup) vs 3 -> 5 (+1 Fib step = NOT blowup)
  const fullSet = [
    ...smallSet,
    makeRec({ issue_id: "SOF-5", cost_usd: 0.1, review_verdict: "FAIL", execution: "minor_rework" }),
    makeRec({
      issue_id: "SOF-6",
      estimate_points: 1,
      felt_points: 3,
      cost_usd: 0.2,
      model: "weird|model\nname",
      notes: "pipe|note\nline2",
    }),
    makeRec({ issue_id: "SOF-7", estimate_points: 3, felt_points: 5, cost_usd: 0.3 }),
  ];
  const report = buildCalibrationReport(fullSet);
  assert.equal(report.alerts.filter((a) => a.kind === "cost_outlier").length, 1);
  assert.equal(report.alerts.find((a) => a.kind === "cost_outlier").issue_id, "SOF-4");

  const blowups = report.alerts.filter((a) => a.kind === "scope_blowup");
  assert.equal(blowups.length, 1);
  assert.equal(blowups[0].issue_id, "SOF-6");

  // Weighted calibration_ratio = sum(felt) / sum(est) = 18 / 14 = 1.29
  assert.equal(report.summary.calibration_ratio, 1.29);
  assert.equal(report.summary.rework_count, 1);
  assert.equal(report.summary.review_verdicts.pass, 6);
  assert.equal(report.summary.review_verdicts.fail, 1);
  assert.equal(typeof report.summary.median_cost_per_point_usd, "number");

  // GFM table cell escaping
  const md = formatReportMarkdown(report);
  assert.ok(md.includes("weird\\|model name"));

  // Filters & repricing with custom table
  const filtered = buildCalibrationReport(fullSet, {
    model: "claude-sonnet",
    since: "2026-11-24T00:00:00Z",
    pricingTable: [{ match: "claude-sonnet-4.6", inputPer1M: 100, outputPer1M: 200, cacheReadPer1M: 0, cacheWritePer1M: 0 }],
  });
  assert.equal(filtered.summary.total_issues, 6);
  assert.equal(filtered.summary.total_cost_usd, 8.4);
});

test("CLI: size-check split gate (exit 2 on 8 pts, exit 0 on 3 pts), unknown flag rejection, log + import-transcript + report end-to-end", () => {
  assert.throws(() => parseCliArgs(["report", "--unknown-flag"]), /Unknown option/);

  // size-check --estimate 3 exits 0 with OK
  const sizeOkOut = execFileSync(
    process.execPath,
    [CLI_PATH, "size-check", "--estimate", "3", "--json"],
    { encoding: "utf8" }
  );
  const sizeOk = JSON.parse(sizeOkOut);
  assert.equal(sizeOk.status, "OK");
  assert.equal(sizeOk.must_split, false);

  // size-check --estimate 8 exits 2 with SPLIT_REQUIRED
  let exit8 = null;
  try {
    execFileSync(process.execPath, [CLI_PATH, "size-check", "--estimate", "8", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    exit8 = err;
  }
  assert.ok(exit8, "size-check --estimate 8 must exit non-zero");
  assert.equal(exit8.status, 2);
  const size8 = JSON.parse(exit8.stdout);
  assert.equal(size8.status, "SPLIT_REQUIRED");
  assert.equal(size8.must_split, true);

  const dir = makeTempDir();
  try {
    const storePath = path.join(dir, "cli-test.jsonl");
    const wsDir = path.join(dir, "workspace");
    fs.mkdirSync(wsDir, { recursive: true });

    // End-to-end log
    const logOut = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "log",
        "--dir",
        wsDir,
        "--store",
        storePath,
        "--issue",
        "SOF-99",
        "--project",
        "P-SOF-7",
        "--phase",
        "specs",
        "--model",
        "claude-sonnet-4.6",
        "--estimate",
        "3",
        "--felt",
        "3",
        "--uncached-input-tokens",
        "100000",
        "--output-tokens",
        "20000",
        "--cost-usd",
        "$1.25",
        "--json",
      ],
      { encoding: "utf8" }
    );
    const logged = JSON.parse(logOut);
    assert.equal(logged.record.cost_usd, 1.25);
    assert.equal(logged.written, 1);

    // End-to-end import-transcript
    const transcriptFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify({
        timestamp: "2026-11-24T12:00:00Z",
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 10000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 2000 } },
      }) + "\n",
      "utf8"
    );
    const importOut = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "import-transcript",
        "--dir",
        wsDir,
        "--store",
        storePath,
        "--input",
        transcriptFile,
        "--issue",
        "SOF-100",
        "--project",
        "P-SOF-7",
        "--phase",
        "architecture",
        "--estimate",
        "2",
        "--json",
      ],
      { encoding: "utf8" }
    );
    const imported = JSON.parse(importOut);
    assert.equal(imported.written, 1);
    assert.equal(imported.record.uncached_input_tokens, 8000);
    assert.equal(imported.record.cache_read_tokens, 2000);

    // End-to-end report with --pricing override & --phase filter
    const pricingFile = path.join(dir, "override.json");
    fs.writeFileSync(
      pricingFile,
      JSON.stringify({ "claude-sonnet-4.6": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12 } }),
      "utf8"
    );
    const reportOut = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "report",
        "--dir",
        wsDir,
        "--store",
        storePath,
        "--pricing",
        pricingFile,
        "--project",
        "P-SOF-7",
        "--phase",
        "specs",
        "--json",
      ],
      { encoding: "utf8" }
    );
    const report = JSON.parse(reportOut);
    assert.equal(report.summary.total_issues, 1);
    assert.equal(report.summary.total_cost_usd, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
