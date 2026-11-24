import fs from "node:fs";
import path from "node:path";
import { normalizeExecution, normalizeTelemetryRecord } from "./schema.mjs";
import { estimateCostUsd, DEFAULT_PRICING_TABLE } from "./pricing.mjs";

function parseCostAndTokens(rawValue) {
  if (!rawValue || /^n\/?a\b/i.test(rawValue.trim())) {
    return { input_tokens: null, output_tokens: null, cached_tokens: null, cost_usd: null };
  }

  let costUsd = null;
  const costMatch = rawValue.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (costMatch) {
    costUsd = Number(costMatch[1]);
  }

  const parseTokenNum = (pattern) => {
    const m = rawValue.match(pattern);
    if (!m) return null;
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) return null;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "m") return Math.round(base * 1_000_000);
    if (unit === "k") return Math.round(base * 1_000);
    return Math.round(base);
  };

  const inputTokens = parseTokenNum(/([0-9][0-9,.]*)\s*([km])?\s*(?:in|input)\b/i);
  const outputTokens = parseTokenNum(/([0-9][0-9,.]*)\s*([km])?\s*(?:out|output)\b/i);
  const cachedTokens = parseTokenNum(/([0-9][0-9,.]*)\s*([km])?\s*(?:cached|cache)\b/i);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: cachedTokens,
    cost_usd: costUsd,
  };
}

/**
 * Parse a single Linear "### Telemetry (Track #4 Bootstrap)" markdown comment body
 * into a canonical telemetry v1 record (or null if no telemetry block is present).
 */
export function parseBootstrapComment(
  commentBody,
  { issueId, projectId = null, recordedAt = null, pricingTable = DEFAULT_PRICING_TABLE } = {}
) {
  if (typeof commentBody !== "string" || !/###\s*Telemetry\b/i.test(commentBody)) {
    return null;
  }

  const sectionIdx = commentBody.search(/###\s*Telemetry\b/i);
  const block = commentBody.slice(sectionIdx);

  const modelMatch = block.match(/-\s*\*\*Model:\*\*\s*(.+)/i);
  const sizeMatch = block.match(
    /-\s*\*\*Estimate vs\.?\s*Felt Size:\*\*\s*(\d+)\s*pts?\s*(?:->|→)\s*(\d+)\s*pts?/i
  );
  const tokMatch = block.match(/-\s*\*\*Tokens\s*\/\s*Cost:\*\*\s*(.+)/i);
  const execMatch = block.match(/-\s*\*\*Execution:\*\*\s*([^—\-\n]+)(?:[—\-]+\s*(.+))?/i);

  if (!sizeMatch) {
    return null;
  }

  const model = modelMatch ? modelMatch[1].trim() : "unknown";
  const estimatePoints = Number(sizeMatch[1]);
  const feltPoints = Number(sizeMatch[2]);
  const { input_tokens, output_tokens, cached_tokens, cost_usd } = parseCostAndTokens(
    tokMatch ? tokMatch[1].trim() : ""
  );
  const execution = normalizeExecution(execMatch ? execMatch[1].trim() : "smooth");
  const notes = execMatch && execMatch[2] ? execMatch[2].trim() : "";

  const resolvedCost =
    cost_usd !== null
      ? cost_usd
      : estimateCostUsd({ model, input_tokens, output_tokens, cached_tokens }, pricingTable);

  return normalizeTelemetryRecord({
    issue_id: issueId,
    project_id: projectId,
    recorded_at: recordedAt || new Date().toISOString(),
    model,
    estimate_points: estimatePoints,
    felt_points: feltPoints,
    input_tokens,
    output_tokens,
    cached_tokens,
    cost_usd: resolvedCost,
    execution,
    notes,
    source: "linear_bootstrap",
  });
}

/**
 * Parse a JSON export of Linear issues/comments (or array of { issue_id, project_id?, body, createdAt? })
 * and return all extracted canonical telemetry records.
 */
export function parseBootstrapExport(input, { pricingTable = DEFAULT_PRICING_TABLE } = {}) {
  const entries = Array.isArray(input)
    ? input
    : Array.isArray(input?.comments)
      ? input.comments
      : Array.isArray(input?.issues)
        ? input.issues
        : [];

  const records = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    // Shape A: { issue_id / issueId, project_id?, body, createdAt? }
    if (typeof entry.body === "string") {
      const issueId = entry.issue_id || entry.issueId || entry.issue?.identifier || entry.id;
      if (!issueId) continue;
      const rec = parseBootstrapComment(entry.body, {
        issueId,
        projectId: entry.project_id || entry.projectId || null,
        recordedAt: entry.createdAt || entry.recorded_at || null,
        pricingTable,
      });
      if (rec) records.push(rec);
      continue;
    }

    // Shape B: issue object containing comments[]
    if (Array.isArray(entry.comments)) {
      const issueId = entry.identifier || entry.id;
      const projectId = entry.project_id || entry.projectId || entry.project?.id || null;
      for (const c of entry.comments) {
        if (!c || typeof c.body !== "string") continue;
        const rec = parseBootstrapComment(c.body, {
          issueId,
          projectId,
          recordedAt: c.createdAt || c.recorded_at || null,
          pricingTable,
        });
        if (rec) records.push(rec);
      }
    }
  }
  return records;
}

/**
 * Parse a local agent JSONL transcript (Antigravity transcript.jsonl, Claude Code, Gemini CLI)
 * to extract model name, turn count, and token usage gracefully (null when unavailable).
 */
export function parseTranscriptJsonl(
  filePath,
  {
    issueId,
    projectId = null,
    phase = null,
    estimatePoints,
    feltPoints = null,
    modelOverride = null,
    execution = "smooth",
    notes = "",
    pricingTable = DEFAULT_PRICING_TABLE,
  }
) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Transcript file not found: ${absPath}`);
  }

  const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
  let detectedModel = null;
  let inputSum = 0;
  let outputSum = 0;
  let cachedSum = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCached = false;
  let stepsCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    stepsCount += 1;

    const modelCandidate =
      obj.model || obj.model_name || obj.metadata?.model || obj.message?.model || null;
    if (typeof modelCandidate === "string" && modelCandidate.trim()) {
      detectedModel = modelCandidate.trim();
    }

    const usage = obj.usage || obj.token_usage || obj.usageMetadata || obj.message?.usage || null;
    if (usage && typeof usage === "object") {
      const inVal =
        usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? null;
      const outVal =
        usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? null;
      const cacheVal =
        usage.cached_tokens ??
        usage.cache_read_input_tokens ??
        usage.cachedContentTokenCount ??
        null;

      if (typeof inVal === "number" && Number.isFinite(inVal)) {
        inputSum += inVal;
        sawInput = true;
      }
      if (typeof outVal === "number" && Number.isFinite(outVal)) {
        outputSum += outVal;
        sawOutput = true;
      }
      if (typeof cacheVal === "number" && Number.isFinite(cacheVal)) {
        cachedSum += cacheVal;
        sawCached = true;
      }
    }
  }

  const finalModel = modelOverride || detectedModel || "unknown";
  const input_tokens = sawInput ? Math.round(inputSum) : null;
  const output_tokens = sawOutput ? Math.round(outputSum) : null;
  const cached_tokens = sawCached ? Math.round(cachedSum) : null;
  const cost_usd = estimateCostUsd(
    { model: finalModel, input_tokens, output_tokens, cached_tokens },
    pricingTable
  );

  const summaryNote =
    notes || `Imported from transcript (${stepsCount} JSONL entries).`;

  return normalizeTelemetryRecord({
    issue_id: issueId,
    project_id: projectId,
    phase,
    model: finalModel,
    estimate_points: estimatePoints,
    felt_points: feltPoints ?? estimatePoints,
    input_tokens,
    output_tokens,
    cached_tokens,
    cost_usd,
    execution,
    notes: summaryNote,
    source: "transcript",
  });
}
