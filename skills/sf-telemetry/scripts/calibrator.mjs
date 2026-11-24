import { FIBONACCI_SCALE, TELEMETRY_SCHEMA_VERSION } from "./schema.mjs";

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

function totalTokensOf(rec) {
  const hasAny =
    rec.input_tokens !== null || rec.output_tokens !== null || rec.cached_tokens !== null;
  if (!hasAny) return null;
  return (rec.input_tokens || 0) + (rec.output_tokens || 0) + (rec.cached_tokens || 0);
}

/**
 * Compute full Fibonacci sizing calibration, token/cost baselines per point bucket,
 * model breakdown, and automatic scope/token blowup alerts.
 */
export function buildCalibrationReport(records) {
  const list = Array.isArray(records) ? records : [];
  const generatedAt = new Date().toISOString();

  let exactMatches = 0;
  let withinOneStep = 0;
  let totalEstPoints = 0;
  let totalFeltPoints = 0;
  let totalCostUsd = 0;
  let costSamples = 0;
  let totalTokens = 0;
  let tokenSamples = 0;
  let smoothCount = 0;
  let minorReworkCount = 0;
  let majorReworkCount = 0;

  const ratios = [];
  const byBucketRaw = new Map(FIBONACCI_SCALE.map((pts) => [pts, []]));
  const byModelRaw = new Map();

  for (const r of list) {
    totalEstPoints += r.estimate_points;
    totalFeltPoints += r.felt_points;
    ratios.push(r.felt_points / r.estimate_points);

    if (r.estimate_points === r.felt_points) exactMatches += 1;
    if (Math.abs(fibIndex(r.estimate_points) - fibIndex(r.felt_points)) <= 1) {
      withinOneStep += 1;
    }

    if (r.cost_usd !== null) {
      totalCostUsd += r.cost_usd;
      costSamples += 1;
    }
    const toks = totalTokensOf(r);
    if (toks !== null) {
      totalTokens += toks;
      tokenSamples += 1;
    }

    if (r.execution === "smooth") smoothCount += 1;
    else if (r.execution === "minor_rework") minorReworkCount += 1;
    else majorReworkCount += 1;

    if (byBucketRaw.has(r.estimate_points)) {
      byBucketRaw.get(r.estimate_points).push(r);
    }

    if (!byModelRaw.has(r.model)) byModelRaw.set(r.model, []);
    byModelRaw.get(r.model).push(r);
  }

  // Per-Fibonacci-bucket stats
  const buckets = [];
  const bucketMedianCost = new Map();

  for (const pts of FIBONACCI_SCALE) {
    const items = byBucketRaw.get(pts);
    const feltVals = items.map((r) => r.felt_points);
    const costVals = items.map((r) => r.cost_usd).filter((c) => c !== null);
    const tokVals = items.map(totalTokensOf).filter((t) => t !== null);
    const medCost = median(costVals);
    bucketMedianCost.set(pts, medCost);

    buckets.push({
      estimate_points: pts,
      count: items.length,
      mean_felt_points: feltVals.length ? round2(mean(feltVals)) : null,
      median_felt_points: feltVals.length ? round2(median(feltVals)) : null,
      calibration_ratio: feltVals.length ? round2(mean(feltVals) / pts) : null,
      mean_tokens: tokVals.length ? Math.round(mean(tokVals)) : null,
      median_tokens: tokVals.length ? Math.round(median(tokVals)) : null,
      mean_cost_usd: costVals.length ? round4(mean(costVals)) : null,
      median_cost_usd: medCost !== null ? round4(medCost) : null,
      cost_per_point_usd: costVals.length ? round4(mean(costVals) / pts) : null,
    });
  }

  // Per-model breakdown
  const models = [...byModelRaw.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([model, items]) => {
      const estSum = items.reduce((s, r) => s + r.estimate_points, 0);
      const feltSum = items.reduce((s, r) => s + r.felt_points, 0);
      const costs = items.map((r) => r.cost_usd).filter((c) => c !== null);
      const toks = items.map(totalTokensOf).filter((t) => t !== null);
      const smooth = items.filter((r) => r.execution === "smooth").length;
      return {
        model,
        count: items.length,
        total_estimate_points: estSum,
        total_felt_points: feltSum,
        calibration_ratio: estSum > 0 ? round2(feltSum / estSum) : null,
        smooth_rate_pct: items.length > 0 ? round2((smooth / items.length) * 100) : 0,
        total_tokens: toks.length ? toks.reduce((a, b) => a + b, 0) : null,
        total_cost_usd: costs.length ? round4(costs.reduce((a, b) => a + b, 0)) : null,
      };
    });

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
    if (r.felt_points / r.estimate_points >= 1.6) {
      alerts.push({
        issue_id: r.issue_id,
        severity: "high",
        kind: "scope_blowup",
        message: `${r.issue_id} underestimated significantly (${r.estimate_points} pts -> ${r.felt_points} pts, ${round2(r.felt_points / r.estimate_points)}x).`,
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
    const medCost = bucketMedianCost.get(r.estimate_points);
    if (
      r.cost_usd !== null &&
      medCost !== null &&
      medCost > 0 &&
      r.cost_usd > medCost * 2
    ) {
      alerts.push({
        issue_id: r.issue_id,
        severity: "medium",
        kind: "cost_outlier",
        message: `${r.issue_id} cost ($${round4(r.cost_usd)}) exceeded 2x the ${r.estimate_points}-pt bucket median ($${round4(medCost)}).`,
      });
    }
  }

  const count = list.length;
  const costPointsDenominator = list
    .filter((r) => r.cost_usd !== null)
    .reduce((s, r) => s + r.estimate_points, 0);

  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    report_type: "telemetry-calibration",
    generated_at: generatedAt,
    summary: {
      total_issues: count,
      total_estimate_points: totalEstPoints,
      total_felt_points: totalFeltPoints,
      calibration_ratio: ratios.length ? round2(mean(ratios)) : null,
      exact_match_pct: count ? round2((exactMatches / count) * 100) : 0,
      within_one_fib_step_pct: count ? round2((withinOneStep / count) * 100) : 0,
      smooth_count: smoothCount,
      minor_rework_count: minorReworkCount,
      major_rework_count: majorReworkCount,
      smooth_rate_pct: count ? round2((smoothCount / count) * 100) : 0,
      token_samples: tokenSamples,
      total_tokens: tokenSamples ? totalTokens : null,
      cost_samples: costSamples,
      total_cost_usd: costSamples ? round4(totalCostUsd) : null,
      cost_per_estimate_point_usd:
        costSamples && costPointsDenominator > 0
          ? round4(totalCostUsd / costPointsDenominator)
          : null,
      alerts_count: alerts.length,
    },
    buckets,
    models,
    alerts,
  };
}

/**
 * Format a canonical Linear closing telemetry comment block.
 */
export function formatLinearTelemetryComment(record) {
  const execLabel = record.execution.replace(/_/g, " ");
  let tokCost = "n/a";
  const parts = [];
  if (record.input_tokens !== null || record.output_tokens !== null) {
    const inStr = record.input_tokens !== null ? `${record.input_tokens.toLocaleString("en-US")} in` : "";
    const outStr = record.output_tokens !== null ? `${record.output_tokens.toLocaleString("en-US")} out` : "";
    const cacheStr =
      record.cached_tokens !== null && record.cached_tokens > 0
        ? `${record.cached_tokens.toLocaleString("en-US")} cached`
        : "";
    parts.push([inStr, outStr, cacheStr].filter(Boolean).join(" / "));
  }
  if (record.cost_usd !== null) {
    parts.push(`$${round4(record.cost_usd)}`);
  }
  if (parts.length > 0) tokCost = parts.join(" · ");

  const noteSuffix = record.notes ? ` — ${record.notes}` : "";
  return [
    "### Telemetry (Track #4 Bootstrap)",
    `- **Model:** ${record.model}`,
    `- **Estimate vs. Felt Size:** ${record.estimate_points} pts -> ${record.felt_points} pts`,
    `- **Tokens / Cost:** ${tokCost}`,
    `- **Execution:** ${execLabel}${noteSuffix}`,
  ].join("\n");
}

export function formatReportMarkdown(report) {
  const s = report.summary;
  const lines = [
    "# Software Factory — Sizing & Token/Cost Calibration Report",
    "",
    `- **Issues Analyzed:** ${s.total_issues}`,
    `- **Total Points (Est → Felt):** ${s.total_estimate_points} pts → ${s.total_felt_points} pts (calibration ratio: \`${s.calibration_ratio ?? "n/a"}\`)`,
    `- **Estimate Accuracy:** ${s.exact_match_pct}% exact · ${s.within_one_fib_step_pct}% within ±1 Fibonacci step`,
    `- **Execution Smoothness:** ${s.smooth_rate_pct}% smooth (${s.smooth_count} smooth, ${s.minor_rework_count} minor rework, ${s.major_rework_count} major rework)`,
    `- **Cost & Tokens:** ${s.total_cost_usd !== null ? `$${s.total_cost_usd} total ($${s.cost_per_estimate_point_usd}/est pt across ${s.cost_samples} samples)` : "n/a (no token/cost samples yet)"}`,
    "",
    "## Fibonacci Bucket Calibration",
    "",
    "| Est Pts | Count | Mean Felt | Median Felt | Ratio | Median Tokens | Median Cost | $/Pt |",
    "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
  ];

  for (const b of report.buckets) {
    lines.push(
      `| ${b.estimate_points} | ${b.count} | ${b.mean_felt_points ?? "—"} | ${b.median_felt_points ?? "—"} | ${b.calibration_ratio ?? "—"} | ${b.median_tokens !== null ? b.median_tokens.toLocaleString("en-US") : "—"} | ${b.median_cost_usd !== null ? `$${b.median_cost_usd}` : "—"} | ${b.cost_per_point_usd !== null ? `$${b.cost_per_point_usd}` : "—"} |`
    );
  }

  if (report.models.length > 0) {
    lines.push("", "## Model Breakdown", "");
    lines.push("| Model | Issues | Est Pts | Felt Pts | Smooth % | Total Cost |");
    lines.push("| :--- | :---: | :---: | :---: | :---: | :---: |");
    for (const m of report.models) {
      lines.push(
        `| ${m.model} | ${m.count} | ${m.total_estimate_points} | ${m.total_felt_points} | ${m.smooth_rate_pct}% | ${m.total_cost_usd !== null ? `$${m.total_cost_usd}` : "n/a"} |`
      );
    }
  }

  if (report.alerts.length > 0) {
    lines.push("", "## Scope & Cost Blowup Alerts", "");
    for (const a of report.alerts) {
      lines.push(`- **[${a.severity.toUpperCase()} · ${a.kind}]** ${a.message}`);
    }
  } else {
    lines.push("", "## Scope & Cost Blowup Alerts", "", "- None — all tracked issues stayed within calibration guardrails.");
  }

  return lines.join("\n");
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

export function formatReportAscii(report) {
  const s = report.summary;
  const lines = [
    "Software Factory — Agile Sizing & Token/Cost Calibration",
    "=".repeat(84),
    `Issues: ${s.total_issues} | Est->Felt: ${s.total_estimate_points}->${s.total_felt_points} pts (ratio: ${s.calibration_ratio ?? "n/a"}) | Accuracy: ${s.exact_match_pct}% exact, ${s.within_one_fib_step_pct}% +/-1 step`,
    `Execution: ${s.smooth_rate_pct}% smooth (${s.smooth_count} smooth, ${s.minor_rework_count} minor, ${s.major_rework_count} major) | Cost: ${s.total_cost_usd !== null ? `$${s.total_cost_usd} ($${s.cost_per_estimate_point_usd}/pt)` : "n/a"}`,
    "-".repeat(84),
    `${padRight("Bucket", 8)}${padRight("Count", 7)}${padRight("MeanFelt", 10)}${padRight("Ratio", 8)}${padRight("MedTokens", 13)}${padRight("MedCost", 11)}$/Pt`,
  ];

  for (const b of report.buckets) {
    lines.push(
      `${padRight(`${b.estimate_points} pts`, 8)}${padRight(b.count, 7)}${padRight(b.mean_felt_points ?? "-", 10)}${padRight(b.calibration_ratio ?? "-", 8)}${padRight(b.median_tokens !== null ? b.median_tokens.toLocaleString("en-US") : "-", 13)}${padRight(b.median_cost_usd !== null ? `$${b.median_cost_usd}` : "-", 11)}${b.cost_per_point_usd !== null ? `$${b.cost_per_point_usd}` : "-"}`
    );
  }

  if (report.alerts.length > 0) {
    lines.push("-".repeat(84));
    lines.push(`Alerts (${report.alerts.length}):`);
    for (const a of report.alerts) {
      lines.push(`  ! [${a.severity.toUpperCase()} ${a.kind}] ${a.message}`);
    }
  }

  return lines.join("\n");
}
