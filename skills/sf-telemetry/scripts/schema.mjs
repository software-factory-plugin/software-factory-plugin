import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { hashShort } from "../../../lib/cli-utils.mjs";
import { isPathInside } from "../../../lib/fs-safe.mjs";

export const TELEMETRY_SCHEMA_VERSION = "2.0";
export const FIBONACCI_SCALE = Object.freeze([1, 2, 3, 5, 8]);
const FIBONACCI_SET = new Set(FIBONACCI_SCALE);

export const FIBONACCI_RUBRIC = Object.freeze({
  1: "Trivial, single-file tweak or copy update; zero design ambiguity.",
  2: "Small, scoped change across 1-3 files; straightforward verification.",
  3: "Medium; multi-file change, single skill update, or focused design spec.",
  5: "Large; new skill, integration, or cross-pipeline change with meaningful validation.",
  8: "Epic / high token-variance risk — MUST be decomposed into 1-5 pt issues before starting.",
});

export const EXECUTION_VALUES = Object.freeze([
  "smooth",
  "minor_rework",
  "major_rework",
  "blocked",
]);

const EXECUTION_ALIASES = new Map([
  ["smooth", "smooth"],
  ["first_pass", "smooth"],
  ["firstpass", "smooth"],
  ["minor_rework", "minor_rework"],
  ["major_rework", "major_rework"],
  ["blocked", "blocked"],
]);

const ALLOWED_SOURCES = new Set(["linear_bootstrap", "transcript", "manual"]);
const ALLOWED_VERDICTS = new Set(["PASS", "FAIL"]);
const DARWIN_ROOT_SYMLINKS = new Set(["/var", "/tmp", "/etc"]);
const PROTECTED_CHMOD_DIRS = new Set(["/", "/tmp", "/private/tmp"]);

export function isValidFibonacci(n) {
  return typeof n === "number" && Number.isInteger(n) && FIBONACCI_SET.has(n);
}

export function normalizeFibonacci(raw, fieldName) {
  if (typeof raw === "boolean") {
    throw new Error(
      `Invalid ${fieldName} "${String(raw)}": must be a Fibonacci estimate (${FIBONACCI_SCALE.join(", ")})`
    );
  }
  let num;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || !/^[0-9]+$/.test(trimmed)) {
      throw new Error(
        `Invalid ${fieldName} "${raw}": must be a Fibonacci estimate (${FIBONACCI_SCALE.join(", ")})`
      );
    }
    num = Number(trimmed);
  } else {
    num = raw;
  }
  if (!isValidFibonacci(num)) {
    throw new Error(
      `Invalid ${fieldName} "${String(raw)}": must be a Fibonacci estimate (${FIBONACCI_SCALE.join(", ")})`
    );
  }
  return num;
}

export function normalizeExecution(raw) {
  if (raw === undefined || raw === null) return "smooth";
  if (typeof raw !== "string") {
    throw new Error(
      `Invalid execution "${String(raw)}": expected one of ${EXECUTION_VALUES.join(", ")} (or first-pass)`
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      `Invalid execution "${raw}": expected one of ${EXECUTION_VALUES.join(", ")} (or first-pass)`
    );
  }
  const cleaned = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const mapped = EXECUTION_ALIASES.get(cleaned);
  if (!mapped) {
    throw new Error(
      `Invalid execution "${raw}": expected one of ${EXECUTION_VALUES.join(", ")} (or first-pass)`
    );
  }
  return mapped;
}

function normalizeOptionalInt(raw, fieldName) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") {
    throw new Error(`Invalid ${fieldName}: expected finite non-negative integer`);
  }
  let n;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(`Invalid ${fieldName}: empty or whitespace-only numeric string`);
    }
    const stripped = trimmed.replace(/,/g, "");
    if (!/^[0-9]+$/.test(stripped)) {
      throw new Error(`Invalid ${fieldName} "${raw}": expected finite non-negative integer`);
    }
    n = Number(stripped);
  } else if (typeof raw === "number") {
    n = raw;
  } else {
    throw new Error(`Invalid ${fieldName}: expected finite non-negative integer`);
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${fieldName} "${String(raw)}": expected finite non-negative integer`);
  }
  return n;
}

function normalizeOptionalCost(raw, fieldName = "cost_usd") {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") {
    throw new Error(`Invalid ${fieldName}: expected finite non-negative number`);
  }
  let n;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(`Invalid ${fieldName}: empty or whitespace-only numeric string`);
    }
    const withoutDollar = trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
    if (!withoutDollar) {
      throw new Error(`Invalid ${fieldName} "${raw}": expected finite non-negative number`);
    }
    const stripped = withoutDollar.replace(/,/g, "");
    if (!/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(stripped)) {
      throw new Error(`Invalid ${fieldName} "${raw}": expected finite non-negative number`);
    }
    n = Number(stripped);
  } else if (typeof raw === "number") {
    n = raw;
  } else {
    throw new Error(`Invalid ${fieldName}: expected finite non-negative number`);
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${fieldName} "${String(raw)}": expected finite non-negative number`);
  }
  return Math.round(n * 1e6) / 1e6;
}

function normalizeModelBreakdown(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new Error("Invalid model_breakdown: expected an array");
  }
  if (raw.length === 0) return null;

  return raw.map((item, idx) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid model_breakdown[${idx}]: expected an object`);
    }
    const model = typeof item.model === "string" ? item.model.trim() : "";
    if (!model) {
      throw new Error(`Invalid model_breakdown[${idx}].model: expected non-empty string`);
    }
    return {
      model,
      uncached_input_tokens:
        normalizeOptionalInt(
          item.uncached_input_tokens,
          `model_breakdown[${idx}].uncached_input_tokens`
        ) ?? 0,
      cache_read_tokens:
        normalizeOptionalInt(
          item.cache_read_tokens,
          `model_breakdown[${idx}].cache_read_tokens`
        ) ?? 0,
      cache_write_tokens:
        normalizeOptionalInt(
          item.cache_write_tokens,
          `model_breakdown[${idx}].cache_write_tokens`
        ) ?? 0,
      output_tokens:
        normalizeOptionalInt(item.output_tokens, `model_breakdown[${idx}].output_tokens`) ?? 0,
      cost_usd: normalizeOptionalCost(item.cost_usd, `model_breakdown[${idx}].cost_usd`),
    };
  });
}

/**
 * Sum non-overlapping input token buckets (uncached + cache_read + cache_write).
 * Returns null if all input token buckets are null/undefined.
 */
export function totalInputTokens(record) {
  if (!record || typeof record !== "object") return null;
  const hasAny =
    (record.uncached_input_tokens !== null && record.uncached_input_tokens !== undefined) ||
    (record.cache_read_tokens !== null && record.cache_read_tokens !== undefined) ||
    (record.cache_write_tokens !== null && record.cache_write_tokens !== undefined);
  if (!hasAny) return null;
  return (
    (record.uncached_input_tokens || 0) +
    (record.cache_read_tokens || 0) +
    (record.cache_write_tokens || 0)
  );
}

/**
 * Sum all non-overlapping token buckets (uncached_input + cache_read + cache_write + output).
 * Returns null if all token buckets are null/undefined.
 */
export function totalTokens(record) {
  if (!record || typeof record !== "object") return null;
  const inTotal = totalInputTokens(record);
  const hasOut = record.output_tokens !== null && record.output_tokens !== undefined;
  if (inTotal === null && !hasOut) return null;
  return (inTotal || 0) + (record.output_tokens || 0);
}

export function normalizeTelemetryRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Telemetry record must be a JSON object");
  }

  if (input.schema_version !== undefined && input.schema_version !== null) {
    if (input.schema_version !== TELEMETRY_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema_version "${String(input.schema_version)}": expected "${TELEMETRY_SCHEMA_VERSION}"`
      );
    }
  }

  const issueId = typeof input.issue_id === "string" ? input.issue_id.trim() : "";
  if (!issueId) {
    throw new Error("Telemetry record requires a non-empty 'issue_id'");
  }

  const model =
    typeof input.model === "string" && input.model.trim() ? input.model.trim() : "unknown";

  const estimatePoints = normalizeFibonacci(input.estimate_points, "estimate_points");
  const feltPoints =
    input.felt_points === undefined || input.felt_points === null
      ? estimatePoints
      : normalizeFibonacci(input.felt_points, "felt_points");

  const execution = normalizeExecution(input.execution);
  let reworkCount = normalizeOptionalInt(input.rework_count, "rework_count");
  if (reworkCount === null) {
    reworkCount = execution === "major_rework" ? 2 : execution === "minor_rework" ? 1 : 0;
  }

  let reviewVerdict = null;
  if (input.review_verdict !== undefined && input.review_verdict !== null) {
    if (typeof input.review_verdict !== "string" || !input.review_verdict.trim()) {
      throw new Error(`Invalid review_verdict "${String(input.review_verdict)}": expected PASS or FAIL`);
    }
    const v = input.review_verdict.trim().toUpperCase();
    if (!ALLOWED_VERDICTS.has(v)) {
      throw new Error(`Invalid review_verdict "${input.review_verdict}": expected PASS or FAIL`);
    }
    reviewVerdict = v;
  }

  let source = "manual";
  if (input.source !== undefined && input.source !== null) {
    if (typeof input.source !== "string") {
      throw new Error(`Invalid source "${String(input.source)}"`);
    }
    const rawSource = input.source.trim().toLowerCase();
    if (!ALLOWED_SOURCES.has(rawSource)) {
      throw new Error(
        `Invalid source "${input.source}": expected one of ${[...ALLOWED_SOURCES].join(", ")}`
      );
    }
    source = rawSource;
  }

  let sourceRef = null;
  if (input.source_ref !== undefined && input.source_ref !== null) {
    if (typeof input.source_ref !== "string") {
      throw new Error("Invalid source_ref: expected a string");
    }
    const trimmedRef = input.source_ref.trim();
    sourceRef = trimmedRef || null;
  }

  let recordedAt;
  if (input.recorded_at !== undefined && input.recorded_at !== null) {
    if (typeof input.recorded_at !== "string" || Number.isNaN(Date.parse(input.recorded_at))) {
      throw new Error(`Invalid recorded_at "${String(input.recorded_at)}": expected ISO-8601 timestamp`);
    }
    recordedAt = new Date(input.recorded_at).toISOString();
  } else {
    recordedAt = new Date().toISOString();
  }

  const uncachedInputTokens = normalizeOptionalInt(
    input.uncached_input_tokens,
    "uncached_input_tokens"
  );
  const cacheReadTokens = normalizeOptionalInt(input.cache_read_tokens, "cache_read_tokens");
  const cacheWriteTokens = normalizeOptionalInt(input.cache_write_tokens, "cache_write_tokens");
  const outputTokens = normalizeOptionalInt(input.output_tokens, "output_tokens");
  const costUsd = normalizeOptionalCost(input.cost_usd, "cost_usd");
  const modelBreakdown = normalizeModelBreakdown(input.model_breakdown);

  const record = {
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
    uncached_input_tokens: uncachedInputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    execution,
    rework_count: reworkCount,
    review_verdict: reviewVerdict,
    notes: typeof input.notes === "string" ? input.notes.trim() : "",
    source,
    source_ref: sourceRef,
  };

  if (modelBreakdown !== null) {
    record.model_breakdown = modelBreakdown;
  }

  return record;
}

/**
 * Deterministic deduplication / upsert key.
 * Prefers stable `source_ref` (e.g. `transcript:sha256:<hex>` or `linear-comment:<id>`).
 */
export function recordDedupKey(record) {
  if (record.source_ref) {
    return `ref:${record.source_ref}`;
  }
  return `key:${record.issue_id}\u0000${record.source}\u0000${record.recorded_at}\u0000${record.model}`;
}

function canonicalizePathWithMissingTail(targetPath) {
  const abs = path.resolve(targetPath);
  const tail = [];
  let cur = abs;
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function findGitRoot(startDir) {
  let cur = canonicalizePathWithMissingTail(startDir);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function assertNoSymlinkInPath(absTarget) {
  const parsed = path.parse(absTarget);
  const rel = absTarget.slice(parsed.root.length);
  const segments = rel.split(path.sep).filter(Boolean);
  let cur = parsed.root;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    if (process.platform === "darwin" && DARWIN_ROOT_SYMLINKS.has(cur)) {
      continue;
    }
    let lst;
    try {
      lst = fs.lstatSync(cur);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        break;
      }
      throw err;
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`Telemetry store path must not point to or traverse a symlink: ${cur}`);
    }
  }
}

/**
 * Enforce out-of-repo privacy and path hygiene for explicit/env telemetry store paths.
 */
export function validateStorePath(storePath, { workspaceRoot = process.cwd() } = {}) {
  if (typeof storePath !== "string" || !storePath.trim()) {
    throw new Error("Telemetry store path must be a non-empty string");
  }
  if (storePath.includes("\0")) {
    throw new Error("Telemetry store path must not contain NUL bytes");
  }

  const absTarget = path.resolve(storePath.trim());
  if (!absTarget.endsWith(".jsonl")) {
    throw new Error(`Telemetry store path must end with ".jsonl": ${absTarget}`);
  }

  assertNoSymlinkInPath(absTarget);

  const canonicalTarget = canonicalizePathWithMissingTail(absTarget);
  const absWorkspace = path.resolve(workspaceRoot);
  const canonicalWorkspace = canonicalizePathWithMissingTail(absWorkspace);

  if (isPathInside(absWorkspace, absTarget) || isPathInside(canonicalWorkspace, canonicalTarget)) {
    throw new Error(
      `Telemetry store path must stay outside the workspace directory (${absWorkspace}): ${absTarget}`
    );
  }

  const gitRoot = findGitRoot(absWorkspace);
  if (gitRoot && (isPathInside(gitRoot, absTarget) || isPathInside(gitRoot, canonicalTarget))) {
    throw new Error(
      `Telemetry store path must stay outside the git repository root (${gitRoot}): ${absTarget}`
    );
  }

  return absTarget;
}

/**
 * Resolve default out-of-repo telemetry JSONL store path with deterministic
 * `<slug>-<sha256-8>.jsonl` naming so workspaces sharing a basename never collide.
 */
export function resolveDefaultStorePath(workspaceRoot = process.cwd()) {
  if (process.env.SF_TELEMETRY_STORE && process.env.SF_TELEMETRY_STORE.trim()) {
    return validateStorePath(process.env.SF_TELEMETRY_STORE.trim(), { workspaceRoot });
  }
  const canonicalWorkspace = canonicalizePathWithMissingTail(workspaceRoot);
  const baseSlug =
    path
      .basename(canonicalWorkspace)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default";
  const suffix = hashShort(canonicalWorkspace, 8);
  const xdg = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(xdg, "software-factory", "telemetry", `${baseSlug}-${suffix}.jsonl`);
}

function ensurePrivateDir(dirPath) {
  const absDir = path.resolve(dirPath);
  const existed = fs.existsSync(absDir);
  fs.mkdirSync(absDir, { recursive: true, mode: 0o700 });
  const home = path.resolve(os.homedir());
  const tmp = path.resolve(os.tmpdir());
  const realTmp = canonicalizePathWithMissingTail(tmp);
  const shouldChmod =
    !existed ||
    (!PROTECTED_CHMOD_DIRS.has(absDir) &&
      absDir !== home &&
      absDir !== tmp &&
      absDir !== realTmp);
  if (shouldChmod) {
    try {
      fs.chmodSync(absDir, 0o700);
    } catch {
      // ignore chmod errors on non-POSIX or unowned dirs
    }
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

function isLockStale(lockPath, staleMs) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch {
    return false;
  }
  let lockTimestamp = stat.mtimeMs;
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)) {
        lockTimestamp = parsed.timestamp;
      }
    }
  } catch {
    // Fall back to mtimeMs if lockfile is partially written or unreadable
  }
  return Date.now() - lockTimestamp > staleMs;
}

function acquireStoreLock(absPath, { staleMs = 30_000, timeoutMs = 5_000, retryMs = 20 } = {}) {
  const lockPath = `${absPath}.lock`;
  ensurePrivateDir(path.dirname(absPath));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + "\n";
        fs.writeSync(fd, payload, null, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.chmodSync(lockPath, 0o600);
      } catch {
        // ignore chmod errors
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore if already removed
        }
      };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }
      if (isLockStale(lockPath, staleMs)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // another process may have removed or replaced it
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for telemetry store lock: ${lockPath}`);
      }
      sleepSync(retryMs);
    }
  }
}

function fileNeedsLeadingNewline(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (stat.size === 0) return false;
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(1);
    const bytesRead = fs.readSync(fd, buf, 0, 1, stat.size - 1);
    return bytesRead === 1 && buf[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteRecords(absPath, records) {
  ensurePrivateDir(path.dirname(absPath));
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  const payload = records.length > 0 ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, absPath);
    fs.chmodSync(absPath, 0o600);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/**
 * Read a v2 telemetry JSONL store.
 * When `lenient` is true (default), corrupt/invalid lines are skipped and returned in
 * `warnings` + `skipped_lines`. When `lenient` is false, any malformed line throws.
 */
export function readTelemetryStore(
  storePath,
  { lenient = true, workspaceRoot = process.cwd() } = {}
) {
  const absPath = validateStorePath(storePath, { workspaceRoot });
  if (!fs.existsSync(absPath)) {
    return { records: [], warnings: [], skipped_lines: 0 };
  }
  const raw = fs.readFileSync(absPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const records = [];
  const warnings = [];
  let skippedLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = `Line ${i + 1} of ${absPath}: invalid JSON (${err.message})`;
      if (!lenient) throw new Error(msg);
      skippedLines += 1;
      warnings.push(msg);
      continue;
    }
    try {
      records.push(normalizeTelemetryRecord(parsed));
    } catch (err) {
      const msg = `Line ${i + 1} of ${absPath}: ${err.message}`;
      if (!lenient) throw new Error(msg);
      skippedLines += 1;
      warnings.push(msg);
    }
  }

  return { records, warnings, skipped_lines: skippedLines };
}

/**
 * Append or upsert one or more v2 telemetry records to a JSONL store under an advisory lockfile.
 * - `deduplicate: false`: skips reading the store and appends directly (ensuring trailing `\n`).
 * - `deduplicate: true` (default): upserts matching `source_ref` (or fallback dedup key) entries
 *   and rewrites atomically via temp file (0o600) + renameSync when existing entries are replaced.
 */
export function appendTelemetryRecords(
  storePath,
  records,
  { deduplicate = true, upsert = true, workspaceRoot = process.cwd(), lockOptions = {} } = {}
) {
  const absPath = validateStorePath(storePath, { workspaceRoot });
  const normalized = records.map((r) => normalizeTelemetryRecord(r));

  if (normalized.length === 0) {
    return { written: 0, updated: 0, skipped: 0, warnings: [], storePath: absPath };
  }

  const releaseLock = acquireStoreLock(absPath, lockOptions);
  try {
    ensurePrivateDir(path.dirname(absPath));

    if (!deduplicate) {
      const prefix = fileNeedsLeadingNewline(absPath) ? "\n" : "";
      const payload = normalized.map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.appendFileSync(absPath, prefix + payload, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(absPath, 0o600);
      return {
        written: normalized.length,
        updated: 0,
        skipped: 0,
        warnings: [],
        storePath: absPath,
      };
    }

    const { records: existing, warnings } = readTelemetryStore(absPath, {
      lenient: true,
      workspaceRoot,
    });

    const resultRecords = [...existing];
    const indexByKey = new Map();
    for (let i = 0; i < resultRecords.length; i += 1) {
      indexByKey.set(recordDedupKey(resultRecords[i]), i);
    }

    let written = 0;
    let updated = 0;
    let skipped = 0;
    const newlyAppended = [];

    for (const rec of normalized) {
      const key = recordDedupKey(rec);
      if (indexByKey.has(key)) {
        if (upsert) {
          const idx = indexByKey.get(key);
          if (JSON.stringify(resultRecords[idx]) === JSON.stringify(rec)) {
            skipped += 1;
          } else {
            resultRecords[idx] = rec;
            updated += 1;
          }
        } else {
          skipped += 1;
        }
      } else {
        indexByKey.set(key, resultRecords.length);
        resultRecords.push(rec);
        newlyAppended.push(rec);
        written += 1;
      }
    }

    if (written === 0 && updated === 0) {
      return { written: 0, updated: 0, skipped, warnings, storePath: absPath };
    }

    if (updated > 0) {
      atomicWriteRecords(absPath, resultRecords);
    } else {
      const prefix = fileNeedsLeadingNewline(absPath) ? "\n" : "";
      const payload = newlyAppended.map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.appendFileSync(absPath, prefix + payload, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(absPath, 0o600);
    }

    return {
      written,
      updated,
      skipped,
      warnings,
      storePath: absPath,
    };
  } finally {
    releaseLock();
  }
}
