import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const TELEMETRY_SCHEMA_VERSION = "1.0";
export const FIBONACCI_SCALE = Object.freeze([1, 2, 3, 5, 8]);
const FIBONACCI_SET = new Set(FIBONACCI_SCALE);

export const FIBONACCI_RUBRIC = Object.freeze({
  1: "Trivial, single-file tweak or copy update; zero design ambiguity.",
  2: "Small, scoped change across 1-3 files; straightforward verification.",
  3: "Medium; multi-file change, single skill update, or focused design spec.",
  5: "Large; new skill, integration, or cross-pipeline change with meaningful validation.",
  8: "Epic / high token-variance risk — MUST be decomposed into 1-5 pt issues before starting.",
});

const ALLOWED_EXECUTION = new Set(["smooth", "minor_rework", "major_rework"]);
const ALLOWED_SOURCES = new Set(["linear_bootstrap", "transcript", "manual"]);
const ALLOWED_VERDICTS = new Set(["PASS", "FAIL"]);

export function isValidFibonacci(n) {
  return typeof n === "number" && Number.isInteger(n) && FIBONACCI_SET.has(n);
}

export function normalizeFibonacci(raw, fieldName) {
  const num = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : raw;
  if (!isValidFibonacci(num)) {
    throw new Error(
      `Invalid ${fieldName} "${String(raw)}": must be a Fibonacci estimate (${FIBONACCI_SCALE.join(", ")})`
    );
  }
  return num;
}

export function normalizeExecution(raw) {
  if (!raw || typeof raw !== "string") return "smooth";
  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ALLOWED_EXECUTION.has(cleaned)) return cleaned;
  if (cleaned.includes("major")) return "major_rework";
  if (cleaned.includes("minor") || cleaned.includes("rework")) return "minor_rework";
  return "smooth";
}

function normalizeOptionalInt(raw, fieldName) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${fieldName}: expected non-negative integer`);
  }
  return Math.round(n);
}

function normalizeOptionalCost(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw.replace(/[$,]/g, "").trim()) : raw;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid cost_usd: expected non-negative number`);
  }
  return Math.round(n * 1e6) / 1e6;
}

export function normalizeTelemetryRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Telemetry record must be a JSON object");
  }

  const issueId = typeof input.issue_id === "string" ? input.issue_id.trim() : "";
  if (!issueId) {
    throw new Error("Telemetry record requires a non-empty 'issue_id'");
  }

  const model =
    typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : "unknown";

  const estimatePoints = normalizeFibonacci(input.estimate_points, "estimate_points");
  const feltPoints =
    input.felt_points === undefined || input.felt_points === null || input.felt_points === ""
      ? estimatePoints
      : normalizeFibonacci(input.felt_points, "felt_points");

  const execution = normalizeExecution(input.execution);
  let reworkCount = normalizeOptionalInt(input.rework_count, "rework_count");
  if (reworkCount === null) {
    reworkCount = execution === "major_rework" ? 2 : execution === "minor_rework" ? 1 : 0;
  }

  let reviewVerdict = null;
  if (typeof input.review_verdict === "string" && input.review_verdict.trim()) {
    const v = input.review_verdict.trim().toUpperCase();
    if (!ALLOWED_VERDICTS.has(v)) {
      throw new Error(`Invalid review_verdict "${input.review_verdict}": expected PASS or FAIL`);
    }
    reviewVerdict = v;
  }

  const rawSource = typeof input.source === "string" ? input.source.trim().toLowerCase() : "manual";
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : "manual";

  const recordedAt =
    typeof input.recorded_at === "string" && !Number.isNaN(Date.parse(input.recorded_at))
      ? new Date(input.recorded_at).toISOString()
      : new Date().toISOString();

  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    recorded_at: recordedAt,
    issue_id: issueId,
    project_id:
      typeof input.project_id === "string" && input.project_id.trim()
        ? input.project_id.trim()
        : null,
    phase:
      typeof input.phase === "string" && input.phase.trim()
        ? input.phase.trim().toLowerCase()
        : null,
    model,
    estimate_points: estimatePoints,
    felt_points: feltPoints,
    input_tokens: normalizeOptionalInt(input.input_tokens, "input_tokens"),
    output_tokens: normalizeOptionalInt(input.output_tokens, "output_tokens"),
    cached_tokens: normalizeOptionalInt(input.cached_tokens, "cached_tokens"),
    cost_usd: normalizeOptionalCost(input.cost_usd),
    execution,
    rework_count: reworkCount,
    review_verdict: reviewVerdict,
    notes: typeof input.notes === "string" ? input.notes.trim() : "",
    source,
  };
}

/**
 * Resolve default out-of-repo telemetry JSONL store path so consumer repos stay clean.
 */
export function resolveDefaultStorePath(workspaceRoot = process.cwd()) {
  if (process.env.SF_TELEMETRY_STORE && process.env.SF_TELEMETRY_STORE.trim()) {
    return path.resolve(process.env.SF_TELEMETRY_STORE.trim());
  }
  const baseSlug = path
    .basename(path.resolve(workspaceRoot))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
  const xdg = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(xdg, "software-factory", "telemetry", `${baseSlug}.jsonl`);
}

export function readTelemetryStore(storePath) {
  const absPath = path.resolve(storePath);
  if (!fs.existsSync(absPath)) {
    return [];
  }
  const raw = fs.readFileSync(absPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid JSON on line ${i + 1} of ${absPath}: ${err.message}`);
    }
    records.push(normalizeTelemetryRecord(parsed));
  }
  return records;
}

/**
 * Append one or more telemetry records to a JSONL store, deduplicating identical
 * (issue_id, source, recorded_at) entries when requested.
 */
export function appendTelemetryRecords(storePath, records, { deduplicate = true } = {}) {
  const absPath = path.resolve(storePath);
  const normalized = records.map((r) => normalizeTelemetryRecord(r));
  const existing = fs.existsSync(absPath) ? readTelemetryStore(absPath) : [];

  const existingKeys = new Set(
    existing.map((r) => `${r.issue_id}\u0000${r.source}\u0000${r.estimate_points}\u0000${r.felt_points}\u0000${r.model}`)
  );

  const toWrite = [];
  for (const rec of normalized) {
    const key = `${rec.issue_id}\u0000${rec.source}\u0000${rec.estimate_points}\u0000${rec.felt_points}\u0000${rec.model}`;
    if (deduplicate && existingKeys.has(key)) continue;
    existingKeys.add(key);
    toWrite.push(rec);
  }

  if (toWrite.length === 0) {
    return { written: 0, skipped: normalized.length, storePath: absPath };
  }

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const payload = toWrite.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(absPath, payload, "utf8");
  return {
    written: toWrite.length,
    skipped: normalized.length - toWrite.length,
    storePath: absPath,
  };
}
