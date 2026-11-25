import { FIBONACCI_SCALE, TELEMETRY_SCHEMA_VERSION, totalTokens } from "./schema.mjs";
import { estimateCostDetails, normalizeModelId } from "./pricing.mjs";

const MIN_OUTLIER_STRATUM_SIZE = 5;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function fibIndex(pts) {
  return FIBONACCI_SCALE.indexOf(pts);
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function escapeMarkdownInline(value) {
  return String(value ?? "").replace(/\r?\n/g, " ");
}

/**
 * Filter telemetry records by optional project, phase, model, and ISO `since` timestamp.
 */
export function filterRecords(records, { project = null, phase = null, model = null, since = null } = {}) {
  const list = Array.isArray(records) ? records : [];

  let sinceMs = null;
  if (since !== null && since !== undefined && String(since).trim() !== "") {
    sinceMs = Date.parse(String(since).trim());
    if (Number.isNaN(sinceMs)) {
      throw new Error(`Invalid --since date "${String(since)}": expected ISO-8601 date/timestamp`);
    }
  }

  const projectFilter =
    typeof project === "string" && project.trim() ? project.trim().toLowerCase() : null;
  const phaseFilter = typeof phase === "string" && phase.trim() ? phase.trim().toLowerCase() : null;
  const modelFilter = typeof model === "string" && model.trim() ? normalizeModelId(model) : null;

  return list.filter((r) => {
    if (projectFilter && (r.project_id || "").toLowerCase() !== projectFilter) {
      return false;
    }
    if (phaseFilter && (r.phase || "").toLowerCase() !== phaseFilter) {
      return false;
    }
    if (modelFilter && !normalizeModelId(r.model || "").includes(modelFilter)) {
      return false;
    }
    if (sinceMs !== null) {
      const recMs = Date.parse(r.recorded_at);
      if (Number.isNaN(recMs) || recMs < sinceMs) return false;
    }
    return true;
  });
}

/**
 * Recompute record costs from token counts / `model_breakdown` using a supplied pricing table.
 * Preserves stored `cost_usd` on cost-only records that have no token counts.
 */
export function repriceRecords(records, pricingTable) {
  const list = Array.isArray(records) ? records : [];
  if (!pricingTable) {
    return { records: list, warnings: [] };
  }

  const warnings = [];
  const repriced = list.map((rec) => {
    const hasTokens =
      totalTokens(rec) !== null ||
      (Array.isArray(rec.model_breakdown) && rec.model_breakdown.length > 0);
    if (!hasTokens) return rec;

    const details = estimateCostDetails(rec, pricingTable);
    if (details.warnings.length > 0) {
      for (const w of details.warnings) {
        warnings.push(`${rec.issue_id}: ${w}`);
      }
    }
    return {
      ...rec,
      cost_usd: details.cost_usd,
      ...(details.model_breakdown ? { model_breakdown: details.model_breakdown } : {}),
    };
  });

  return { records: repriced, warnings };
}

/**
 * Compute full Fibonacci sizing calibration, token/cost baselines per point bucket,
 * model breakdown, review verdict aggregates, and automatic scope/token blowup alerts.
 */
export function buildCalibrationReport(
  records,
  { project = null, phase = null, model = null, since = null, pricingTable = null } = {}
) {
  const filtered = filterRecords(records, { project, phase, model, since });
  const { records: list, warnings } = repriceRecords(filtered, pricingTable);
  const generatedAt = new Date().toISOString();

  let exactMatches = 0;
  let withinOneStep = 0;
  let totalEstPoints = 0;
  let totalFeltPoints = 0;
  let totalCostUsd = 0;
  let costSamples = 0;
  let totalTokensSum = 0;
  let tokenSamples = 0;
  let smoothCount = 0;
  let minorReworkCount = 0;
  let majorReworkCount = 0;
  let blockedCount = 0;
  let totalReworkCount = 0;
  let verdictPass = 0;
  let verdictFail = 0;
  let verdictUnreviewed = 0;

  const costPerPointSamples = [];
  const byBucketRaw = new Map(FIBONACCI_SCALE.map((pts) => [pts, []]));
  const byModelRaw = new Map();
  // Stratified cost samples keyed by (estimate_points, normalizedModel)
  const costStrata = new Map();

  for (const r of list) {
    totalEstPoints += r.estimate_points;
    totalFeltPoints += r.felt_points;
    totalReworkCount += r.rework_count || 0;

    if (r.estimate_points === r.felt_points) exactMatches += 1;
    if (Math.abs(fibIndex(r.estimate_points) - fibIndex(r.felt_points)) <= 1) {
      withinOneStep += 1;
    }

    if (r.cost_usd !== null && r.cost_usd !== undefined) {
      totalCostUsd += r.cost_usd;
      costSamples += 1;
      costPerPointSamples.push(r.cost_usd / r.estimate_points);

      const stratumKey = `${r.estimate_points}\u0000${normalizeModelId(r.model)}`;
      if (!costStrata.has(stratumKey)) costStrata.set(stratumKey, []);
      costStrata.get(stratumKey).push(r.cost_usd);
    }

    const toks = totalTokens(r);
    if (toks !== null) {
      totalTokensSum += toks;
      tokenSamples += 1;
    }

    if (r.execution === "smooth") smoothCount += 1;
    else if (r.execution === "minor_rework") minorReworkCount += 1;
    else if (r.execution === "major_rework") majorReworkCount += 1;
    else if (r.execution === "blocked") blockedCount += 1;

    if (r.review_verdict === "PASS") verdictPass += 1;
    else if (r.review_verdict === "FAIL") verdictFail += 1;
    else verdictUnreviewed += 1;

    if (byBucketRaw.has(r.estimate_points)) {
      byBucketRaw.get(r.estimate_points).push(r);
    }

    if (!byModelRaw.has(r.model)) byModelRaw.set(r.model, []);
    byModelRaw.get(r.model).push(r);
  }

  // Per-Fibonacci-bucket stats
  const buckets = [];
  for (const pts of FIBONACCI_SCALE) {
    const items = byBucketRaw.get(pts);
    const estSum = items.reduce((s, r) => s + r.estimate_points, 0);
    const feltVals = items.map((r) => r.felt_points);
    const feltSum = feltVals.reduce((s, v) => s + v, 0);
    const costVals = items.map((r) => r.cost_usd).filter((c) => c !== null && c !== undefined);
    const tokVals = items.map(totalTokens).filter((t) => t !== null);
    const medCost = median(costVals);

    buckets.push({
      estimate_points: pts,
      count: items.length,
      mean_felt_points: feltVals.length ? round2(mean(feltVals)) : null,
      median_felt_points: feltVals.length ? round2(median(feltVals)) : null,
      calibration_ratio: estSum > 0 ? round2(feltSum / estSum) : null,
      mean_tokens: tokVals.length ? Math.round(mean(tokVals)) : null,
      median_tokens: tokVals.length ? Math.round(median(tokVals)) : null,
      mean_cost_usd: costVals.length ? round4(mean(costVals)) : null,
      median_cost_usd: medCost !== null ? round4(medCost) : null,
      cost_per_point_usd: costVals.length ? round4(mean(costVals) / pts) : null,
      median_cost_per_point_usd: medCost !== null ? round4(medCost / pts) : null,
    });
  }

  // Per-model breakdown
  const models = [...byModelRaw.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([modelName, items]) => {
      const estSum = items.reduce((s, r) => s + r.estimate_points, 0);
      const feltSum = items.reduce((s, r) => s + r.felt_points, 0);
      const costs = items.map((r) => r.cost_usd).filter((c) => c !== null && c !== undefined);
      const cpp = items
        .filter((r) => r.cost_usd !== null && r.cost_usd !== undefined)
        .map((r) => r.cost_usd / r.estimate_points);
      const toks = items.map(totalTokens).filter((t) => t !== null);
      const smooth = items.filter((r) => r.execution === "smooth").length;
      const reworks = items.reduce((s, r) => s + (r.rework_count || 0), 0);
      return {
        model: modelName,
        count: items.length,
        total_estimate_points: estSum,
        total_felt_points: feltSum,
        calibration_ratio: estSum > 0 ? round2(feltSum / estSum) : null,
        smooth_rate_pct: items.length > 0 ? round2((smooth / items.length) * 100) : 0,
        rework_count: reworks,
        total_tokens: toks.length ? toks.reduce((a, b) => a + b, 0) : null,
        total_cost_usd: costs.length ? round4(costs.reduce((a, b) => a + b, 0)) : null,
        median_cost_per_point_usd: cpp.length ? round4(median(cpp)) : null,
      };
    });

  // Precompute stratified medians for (estimate_points, model) with n >= 5
  const stratumStats = new Map();
  for (const [key, vals] of costStrata.entries()) {
    if (vals.length >= MIN_OUTLIER_STRATUM_SIZE) {
      stratumStats.set(key, { n: vals.length, median: median(vals) });
    }
  }

  // Scope & Token Blowup Alerts
  const alerts = [];
  for (const r of list) {
    if (r.estimate_points === 8) {
      alerts.push({
        issue_id: r.issue_id,
        severity: "high",
        kind: "unsplit_epic_8pt",
        message: `${r.issue_id} was started at 8 pts — Operating Manual requires decomposing 8-pt epics into 1-5 pt issues.`,
      });
    }

    const fibStepDelta = fibIndex(r.felt_points) - fibIndex(r.estimate_points);
    if (fibStepDelta >= 2) {
      alerts.push({
        issue_id: r.issue_id,
        severity: "high",
        kind: "scope_blowup",
        message: `${r.issue_id} underestimated significantly (${r.estimate_points} pts -> ${r.felt_points} pts, +${fibStepDelta} Fibonacci steps).`,
      });
    }

    if (r.execution === "major_rework" || r.rework_count >= 2) {
      alerts.push({
        issue_id: r.issue_id,
        severity: "medium",
        kind: "high_rework",
        message: `${r.issue_id} experienced ${r.execution} (rework_count=${r.rework_count})${r.notes ? `: ${r.notes}` : "."}`,
      });
    }

    if (r.cost_usd !== null && r.cost_usd !== undefined) {
      const stratumKey = `${r.estimate_points}\u0000${normalizeModelId(r.model)}`;
      const stratum = stratumStats.get(stratumKey);
      if (stratum && stratum.median !== null && stratum.median > 0 && r.cost_usd > stratum.median * 2) {
        alerts.push({
          issue_id: r.issue_id,
          severity: "medium",
          kind: "cost_outlier",
          message: `${r.issue_id} cost ($${round4(r.cost_usd)}) exceeded 2x the ${r.estimate_points}-pt ${r.model} median ($${round4(stratum.median)}, n=${stratum.n}).`,
        });
      }
    }
  }

  const count = list.length;
  const costPointsDenominator = list
    .filter((r) => r.cost_usd !== null && r.cost_usd !== undefined)
    .reduce((s, r) => s + r.estimate_points, 0);
  const reviewedCount = verdictPass + verdictFail;
  const medCostPerPoint = median(costPerPointSamples);

  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    report_type: "telemetry-calibration",
    generated_at: generatedAt,
    filters: {
      project: project || null,
      phase: phase || null,
      model: model || null,
      since: since || null,
    },
    summary: {
      total_issues: count,
      total_estimate_points: totalEstPoints,
      total_felt_points: totalFeltPoints,
      calibration_ratio: totalEstPoints > 0 ? round2(totalFeltPoints / totalEstPoints) : null,
      exact_match_pct: count ? round2((exactMatches / count) * 100) : 0,
      within_one_fib_step_pct: count ? round2((withinOneStep / count) * 100) : 0,
      smooth_count: smoothCount,
      minor_rework_count: minorReworkCount,
      major_rework_count: majorReworkCount,
      blocked_count: blockedCount,
      rework_count: totalReworkCount,
      smooth_rate_pct: count ? round2((smoothCount / count) * 100) : 0,
      review_verdicts: {
        pass: verdictPass,
        fail: verdictFail,
        unreviewed: verdictUnreviewed,
        pass_rate_pct: reviewedCount > 0 ? round2((verdictPass / reviewedCount) * 100) : null,
      },
      token_samples: tokenSamples,
      total_tokens: tokenSamples ? totalTokensSum : null,
      cost_samples: costSamples,
      total_cost_usd: costSamples ? round4(totalCostUsd) : null,
      cost_per_estimate_point_usd:
        costSamples && costPointsDenominator > 0
          ? round4(totalCostUsd / costPointsDenominator)
          : null,
      median_cost_per_point_usd: medCostPerPoint !== null ? round4(medCostPerPoint) : null,
      alerts_count: alerts.length,
    },
    buckets,
    models,
    alerts,
    warnings,
  };
}

/**
 * Format a canonical Linear closing telemetry comment block.
 * Includes non-overlapping input, output, cache read, and cache write tokens
 * (including when only cache tokens are non-zero).
 */
export function formatLinearTelemetryComment(record) {
  const execLabel = record.execution.replace(/_/g, " ");
  let tokCost = "n/a";
  const parts = [];
  const tokenParts = [];

  if (record.uncached_input_tokens !== null && record.uncached_input_tokens !== undefined) {
    tokenParts.push(`${record.uncached_input_tokens.toLocaleString("en-US")} in`);
  }
  if (record.output_tokens !== null && record.output_tokens !== undefined) {
    tokenParts.push(`${record.output_tokens.toLocaleString("en-US")} out`);
  }
  if (
    record.cache_read_tokens !== null &&
    record.cache_read_tokens !== undefined &&
    record.cache_read_tokens > 0
  ) {
    tokenParts.push(`${record.cache_read_tokens.toLocaleString("en-US")} cache read`);
  }
  if (
    record.cache_write_tokens !== null &&
    record.cache_write_tokens !== undefined &&
    record.cache_write_tokens > 0
  ) {
    tokenParts.push(`${record.cache_write_tokens.toLocaleString("en-US")} cache write`);
  }

  if (tokenParts.length > 0) {
    parts.push(tokenParts.join(" / "));
  }
  if (record.cost_usd !== null && record.cost_usd !== undefined) {
    parts.push(`$${round4(record.cost_usd)}`);
  }
  if (parts.length > 0) tokCost = parts.join(" · ");

  const noteSuffix = record.notes ? ` — ${escapeMarkdownInline(record.notes)}` : "";
  return [
    "### Telemetry (Track #4 Bootstrap)",
    `- **Model:** ${escapeMarkdownInline(record.model)}`,
    `- **Estimate vs. Felt Size:** ${record.estimate_points} pts -> ${record.felt_points} pts`,
    `- **Tokens / Cost:** ${tokCost}`,
    `- **Execution:** ${execLabel}${noteSuffix}`,
  ].join("\n");
}

export function formatReportMarkdown(report) {
  const s = report.summary;
  const rv = s.review_verdicts || { pass: 0, fail: 0, unreviewed: 0, pass_rate_pct: null };
  const costSummary =
    s.total_cost_usd !== null
      ? `$${s.total_cost_usd} total ($${s.cost_per_estimate_point_usd}/est pt mean · $${s.median_cost_per_point_usd}/pt median across ${s.cost_samples} samples)`
      : "n/a (no token/cost samples yet)";

  const verdictSummary =
    rv.pass + rv.fail > 0
      ? `${rv.pass} PASS, ${rv.fail} FAIL (${rv.pass_rate_pct}% pass rate · ${rv.unreviewed} unreviewed)`
      : `n/a (${rv.unreviewed} unreviewed)`;

  const lines = [
    "# Software Factory — Sizing & Token/Cost Calibration Report",
    "",
    `- **Issues Analyzed:** ${s.total_issues}`,
    `- **Total Points (Est → Felt):** ${s.total_estimate_points} pts → ${s.total_felt_points} pts (calibration ratio: \`${s.calibration_ratio ?? "n/a"}\`)`,
    `- **Estimate Accuracy:** ${s.exact_match_pct}% exact · ${s.within_one_fib_step_pct}% within ±1 Fibonacci step`,
    `- **Execution Smoothness:** ${s.smooth_rate_pct}% smooth (${s.smooth_count} smooth, ${s.minor_rework_count} minor rework, ${s.major_rework_count} major rework, ${s.blocked_count} blocked · ${s.rework_count} total rework cycles)`,
    `- **Review Verdicts:** ${verdictSummary}`,
    `- **Cost & Tokens:** ${costSummary}`,
    "",
    "## Fibonacci Bucket Calibration",
    "",
    "| Est Pts | Count | Mean Felt | Median Felt | Ratio | Median Tokens | Median Cost | Median $/Pt |",
    "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
  ];

  for (const b of report.buckets) {
    lines.push(
      `| ${b.estimate_points} | ${b.count} | ${b.mean_felt_points ?? "—"} | ${b.median_felt_points ?? "—"} | ${b.calibration_ratio ?? "—"} | ${b.median_tokens !== null ? b.median_tokens.toLocaleString("en-US") : "—"} | ${b.median_cost_usd !== null ? `$${b.median_cost_usd}` : "—"} | ${b.median_cost_per_point_usd !== null ? `$${b.median_cost_per_point_usd}` : "—"} |`
    );
  }

  if (report.models.length > 0) {
    lines.push("", "## Model Breakdown", "");
    lines.push("| Model | Issues | Est Pts | Felt Pts | Smooth % | Rework | Median $/Pt | Total Cost |");
    lines.push("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |");
    for (const m of report.models) {
      lines.push(
        `| ${escapeMarkdownCell(m.model)} | ${m.count} | ${m.total_estimate_points} | ${m.total_felt_points} | ${m.smooth_rate_pct}% | ${m.rework_count} | ${m.median_cost_per_point_usd !== null ? `$${m.median_cost_per_point_usd}` : "n/a"} | ${m.total_cost_usd !== null ? `$${m.total_cost_usd}` : "n/a"} |`
      );
    }
  }

  if (report.alerts.length > 0) {
    lines.push("", "## Scope & Cost Blowup Alerts", "");
    for (const a of report.alerts) {
      lines.push(
        `- **[${escapeMarkdownInline(a.severity.toUpperCase())} · ${escapeMarkdownInline(a.kind)}]** ${escapeMarkdownInline(a.message)}`
      );
    }
  } else {
    lines.push(
      "",
      "## Scope & Cost Blowup Alerts",
      "",
      "- None — all tracked issues stayed within calibration guardrails."
    );
  }

  return lines.join("\n");
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

export function formatReportAscii(report) {
  const s = report.summary;
  const rv = s.review_verdicts || { pass: 0, fail: 0, unreviewed: 0, pass_rate_pct: null };
  const lines = [
    "Software Factory — Agile Sizing & Token/Cost Calibration",
    "=".repeat(88),
    `Issues: ${s.total_issues} | Est->Felt: ${s.total_estimate_points}->${s.total_felt_points} pts (ratio: ${s.calibration_ratio ?? "n/a"}) | Accuracy: ${s.exact_match_pct}% exact, ${s.within_one_fib_step_pct}% +/-1 step`,
    `Execution: ${s.smooth_rate_pct}% smooth (${s.smooth_count} smooth, ${s.minor_rework_count} minor, ${s.major_rework_count} major, ${s.blocked_count} blocked; rework=${s.rework_count})`,
    `Reviews: ${rv.pass} PASS / ${rv.fail} FAIL (${rv.pass_rate_pct !== null ? `${rv.pass_rate_pct}%` : "n/a"}) | Cost: ${s.total_cost_usd !== null ? `$${s.total_cost_usd} (mean $${s.cost_per_estimate_point_usd}/pt, med $${s.median_cost_per_point_usd}/pt)` : "n/a"}`,
    "-".repeat(88),
    `${padRight("Bucket", 8)}${padRight("Count", 7)}${padRight("MeanFelt", 10)}${padRight("Ratio", 8)}${padRight("MedTokens", 13)}${padRight("MedCost", 11)}Med $/Pt`,
  ];

  for (const b of report.buckets) {
    lines.push(
      `${padRight(`${b.estimate_points} pts`, 8)}${padRight(b.count, 7)}${padRight(b.mean_felt_points ?? "-", 10)}${padRight(b.calibration_ratio ?? "-", 8)}${padRight(b.median_tokens !== null ? b.median_tokens.toLocaleString("en-US") : "-", 13)}${padRight(b.median_cost_usd !== null ? `$${b.median_cost_usd}` : "-", 11)}${b.median_cost_per_point_usd !== null ? `$${b.median_cost_per_point_usd}` : "-"}`
    );
  }

  if (report.alerts.length > 0) {
    lines.push("-".repeat(88));
    lines.push(`Alerts (${report.alerts.length}):`);
    for (const a of report.alerts) {
      lines.push(`  ! [${a.severity.toUpperCase()} ${a.kind}] ${a.message}`);
    }
  }

  return lines.join("\n");
}
