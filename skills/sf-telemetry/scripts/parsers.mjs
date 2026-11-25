import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { normalizeExecution, normalizeTelemetryRecord } from "./schema.mjs";
import { DEFAULT_PRICING_TABLE, estimateCostDetails } from "./pricing.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COST_RE = /\$[ \t]*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/;

function parseScaledTokenNumber(text, pattern) {
  const m = text.match(pattern);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base) || base < 0) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "m") return Math.round(base * 1_000_000);
  if (unit === "k") return Math.round(base * 1_000);
  return Math.round(base);
}

function parseCostAndTokens(rawValue) {
  const empty = {
    uncached_input_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    output_tokens: null,
    cost_usd: null,
  };
  if (typeof rawValue !== "string") return empty;
  const trimmed = rawValue.trim();
  if (!trimmed || /^n\/?a$/i.test(trimmed)) return empty;

  let costUsd = null;
  let tokenText = trimmed;
  const costMatch = trimmed.match(COST_RE);
  if (costMatch) {
    const parsedCost = Number(costMatch[1].replace(/,/g, ""));
    if (Number.isFinite(parsedCost) && parsedCost >= 0) {
      costUsd = Math.round(parsedCost * 1e6) / 1e6;
    }
    // Strip matched dollar amount before parsing token counts so "$1.50 in total"
    // never misparses "1.50 in" as input tokens.
    tokenText = trimmed.slice(0, costMatch.index) + " " + trimmed.slice(costMatch.index + costMatch[0].length);
  }

  const numToken = "([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?|[0-9]+(?:\\.[0-9]+)?)[ \\t]*([km])?";

  const cacheWriteTokens = parseScaledTokenNumber(
    tokenText,
    new RegExp(`(?<![0-9.$])${numToken}[ \\t]+(?:cache[ _-]write|cache[ _-]creation)\\b`, "i")
  );
  const cacheReadTokens = parseScaledTokenNumber(
    tokenText,
    new RegExp(
      `(?<![0-9.$])${numToken}[ \\t]+(?:cache[ _-]read|cached[ _-]read|cached|cache(?!\\s+(?:write|creation)))\\b`,
      "i"
    )
  );
  const uncachedInputTokens = parseScaledTokenNumber(
    tokenText,
    new RegExp(`(?<![0-9.$])${numToken}[ \\t]+(?:uncached[ _-](?:in|input)|in|input)\\b`, "i")
  );
  const outputTokens = parseScaledTokenNumber(
    tokenText,
    new RegExp(`(?<![0-9.$])${numToken}[ \\t]+(?:out|output)\\b`, "i")
  );

  return {
    uncached_input_tokens: uncachedInputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
  };
}

function extractTelemetrySection(commentBody) {
  const headingRe = /^#{1,6}[ \t]+Telemetry\b[^\n]*/im;
  const match = headingRe.exec(commentBody);
  if (!match) return null;
  const afterHeading = commentBody.slice(match.index + match[0].length);
  const nextHeadingRe = /\r?\n#{1,6}[ \t]+/;
  const nextMatch = nextHeadingRe.exec(afterHeading);
  return nextMatch ? afterHeading.slice(0, nextMatch.index) : afterHeading;
}

function parseExecutionLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return { execution: "smooth", notes: "" };
  const sepMatch = trimmed.match(/[ \t]*(?:—|–|--|[ \t]-[ \t])[ \t]*/);
  if (!sepMatch) {
    return { execution: normalizeExecution(trimmed), notes: "" };
  }
  const execRaw = trimmed.slice(0, sepMatch.index).trim();
  const notes = trimmed.slice(sepMatch.index + sepMatch[0].length).trim();
  return { execution: normalizeExecution(execRaw), notes };
}

/**
 * Parse a single Linear "### Telemetry (Track #4 Bootstrap)" markdown comment body
 * into a canonical v2 telemetry record (or null if no telemetry block is present).
 */
export function parseBootstrapComment(
  commentBody,
  {
    issueId,
    projectId = null,
    phase = null,
    recordedAt = null,
    commentId = null,
    sourceRef = null,
    pricingTable = DEFAULT_PRICING_TABLE,
  } = {}
) {
  if (typeof commentBody !== "string") return null;
  const block = extractTelemetrySection(commentBody);
  if (!block) return null;

  const modelMatch = block.match(/^[ \t]*-[ \t]+\*\*Model:\*\*[ \t]*(.+)$/im);
  const sizeMatch = block.match(
    /^[ \t]*-[ \t]+\*\*Estimate vs\.?[ \t]+Felt Size:\*\*[ \t]*([0-9]+)[ \t]*pts?[ \t]*(?:->|→)[ \t]*([0-9]+)[ \t]*pts?/im
  );
  const tokMatch = block.match(/^[ \t]*-[ \t]+\*\*Tokens[ \t]*\/[ \t]*Cost:\*\*[ \t]*(.+)$/im);
  const execMatch = block.match(/^[ \t]*-[ \t]+\*\*Execution:\*\*[ \t]*(.+)$/im);

  if (!sizeMatch) {
    return null;
  }

  const model = modelMatch ? modelMatch[1].trim() : "unknown";
  const estimatePoints = Number(sizeMatch[1]);
  const feltPoints = Number(sizeMatch[2]);
  const {
    uncached_input_tokens,
    cache_read_tokens,
    cache_write_tokens,
    output_tokens,
    cost_usd,
  } = parseCostAndTokens(tokMatch ? tokMatch[1].trim() : "");

  const { execution, notes } = execMatch
    ? parseExecutionLine(execMatch[1])
    : { execution: "smooth", notes: "" };

  const resolvedCost =
    cost_usd !== null
      ? cost_usd
      : estimateCostDetails(
          {
            model,
            uncached_input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
          },
          pricingTable
        ).cost_usd;

  const resolvedSourceRef =
    sourceRef || (commentId ? `linear-comment:${String(commentId).trim()}` : null);

  return normalizeTelemetryRecord({
    issue_id: issueId,
    project_id: projectId,
    phase,
    recorded_at: recordedAt || new Date().toISOString(),
    model,
    estimate_points: estimatePoints,
    felt_points: feltPoints,
    uncached_input_tokens,
    cache_read_tokens,
    cache_write_tokens,
    output_tokens,
    cost_usd: resolvedCost,
    execution,
    notes,
    source: "linear_bootstrap",
    source_ref: resolvedSourceRef,
  });
}

function resolveCommentList(container) {
  if (Array.isArray(container)) return container;
  if (container && typeof container === "object" && Array.isArray(container.nodes)) {
    return container.nodes;
  }
  return null;
}

function resolveRootEntries(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];
  if (input.data && typeof input.data === "object") {
    return resolveRootEntries(input.data);
  }
  const comments = resolveCommentList(input.comments);
  if (comments) {
    // Distinguish a single issue object `{ identifier, comments }` from a root `{ comments: [...] }` wrapper.
    if (input.identifier || input.issue_id || input.issueId) {
      return [input];
    }
    return comments;
  }
  const issues = resolveCommentList(input.issues);
  if (issues) return issues;
  if (input.issue && typeof input.issue === "object") return [input.issue];
  return [];
}

/**
 * Parse a JSON export of Linear issues/comments (flat arrays or GraphQL `.nodes` shapes).
 * Isolates per-comment parse errors and returns `{ records, warnings }`.
 */
export function parseBootstrapExport(input, { pricingTable = DEFAULT_PRICING_TABLE } = {}) {
  const entries = resolveRootEntries(input);
  const records = [];
  const warnings = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;

    // Shape A: flat comment object `{ issue_id / issueId / issue.identifier, body, id?, createdAt? }`
    if (typeof entry.body === "string") {
      const issueId = entry.issue_id || entry.issueId || entry.issue?.identifier || null;
      if (!issueId || typeof issueId !== "string" || !issueId.trim()) {
        warnings.push(
          `Skipped comment #${i + 1}${entry.id ? ` (${entry.id})` : ""}: missing issue identifier (refusing to fall back to comment UUID).`
        );
        continue;
      }
      try {
        const rec = parseBootstrapComment(entry.body, {
          issueId: issueId.trim(),
          projectId: entry.project_id || entry.projectId || entry.issue?.project?.id || null,
          recordedAt: entry.createdAt || entry.recorded_at || null,
          commentId: entry.id || entry.comment_id || entry.commentId || null,
          pricingTable,
        });
        if (rec) records.push(rec);
      } catch (err) {
        warnings.push(
          `Skipped malformed telemetry comment on ${issueId}${entry.id ? ` (${entry.id})` : ""}: ${err.message}`
        );
      }
      continue;
    }

    // Shape B: issue object containing `comments: [...]` or `comments: { nodes: [...] }`
    const nestedComments = resolveCommentList(entry.comments);
    if (nestedComments) {
      let issueId = entry.identifier || entry.issue_id || entry.issueId || null;
      if (!issueId && typeof entry.id === "string" && !UUID_RE.test(entry.id.trim())) {
        issueId = entry.id.trim();
      }
      if (!issueId || typeof issueId !== "string" || !issueId.trim()) {
        warnings.push(
          `Skipped issue entry #${i + 1}${entry.id ? ` (${entry.id})` : ""}: missing human issue identifier.`
        );
        continue;
      }
      const projectId =
        entry.project_id || entry.projectId || entry.project?.id || entry.project?.name || null;
      for (let j = 0; j < nestedComments.length; j += 1) {
        const c = nestedComments[j];
        if (!c || typeof c.body !== "string") continue;
        try {
          const rec = parseBootstrapComment(c.body, {
            issueId: issueId.trim(),
            projectId,
            recordedAt: c.createdAt || c.recorded_at || null,
            commentId: c.id || c.comment_id || c.commentId || null,
            pricingTable,
          });
          if (rec) records.push(rec);
        } catch (err) {
          warnings.push(
            `Skipped malformed telemetry comment #${j + 1} on ${issueId}${c.id ? ` (${c.id})` : ""}: ${err.message}`
          );
        }
      }
    }
  }

  return { records, warnings };
}

function finiteNonNeg(val) {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? Math.round(val) : null;
}

function numOrZero(val) {
  return finiteNonNeg(val) ?? 0;
}

function normalizeUsageObject(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  // 1. Gemini usageMetadata (promptTokenCount includes cachedContentTokenCount; thoughtsTokenCount bills at output rate)
  if (
    "promptTokenCount" in usage ||
    "candidatesTokenCount" in usage ||
    "cachedContentTokenCount" in usage ||
    "thoughtsTokenCount" in usage
  ) {
    const prompt = numOrZero(usage.promptTokenCount);
    const cacheRead = numOrZero(usage.cachedContentTokenCount);
    const uncachedInput = Math.max(0, prompt - cacheRead);
    const output = numOrZero(usage.candidatesTokenCount) + numOrZero(usage.thoughtsTokenCount);
    return {
      uncached_input_tokens: uncachedInput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: 0,
      output_tokens: output,
    };
  }

  // 2. OpenAI Chat Completions (`prompt_tokens` includes `prompt_tokens_details.cached_tokens`)
  if ("prompt_tokens" in usage || "completion_tokens" in usage) {
    const prompt = numOrZero(usage.prompt_tokens);
    const cacheRead = numOrZero(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens);
    const uncachedInput = Math.max(0, prompt - cacheRead);
    const output = numOrZero(usage.completion_tokens);
    return {
      uncached_input_tokens: uncachedInput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: 0,
      output_tokens: output,
    };
  }

  // 3. Anthropic Messages (`input_tokens` is ALREADY uncached; `cache_read_input_tokens` & `cache_creation_input_tokens` are separate)
  if (
    "cache_read_input_tokens" in usage ||
    "cache_creation_input_tokens" in usage ||
    ("input_tokens" in usage && !("input_tokens_details" in usage) && !("cached_input_tokens" in usage))
  ) {
    const hasAny =
      finiteNonNeg(usage.input_tokens) !== null ||
      finiteNonNeg(usage.output_tokens) !== null ||
      finiteNonNeg(usage.cache_read_input_tokens) !== null ||
      finiteNonNeg(usage.cache_creation_input_tokens) !== null;
    if (!hasAny) return null;
    return {
      uncached_input_tokens: numOrZero(usage.input_tokens),
      cache_read_tokens: numOrZero(usage.cache_read_input_tokens ?? usage.cached_tokens),
      cache_write_tokens: numOrZero(usage.cache_creation_input_tokens),
      output_tokens: numOrZero(usage.output_tokens),
    };
  }

  // 4. OpenAI Responses API / Codex token usage (`input_tokens` includes `cached_input_tokens` / `input_tokens_details.cached_tokens`)
  if ("input_tokens" in usage || "output_tokens" in usage || "cached_input_tokens" in usage) {
    const rawIn = numOrZero(usage.input_tokens);
    const cacheRead = numOrZero(
      usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens
    );
    const uncachedInput = Math.max(0, rawIn - cacheRead);
    let output = numOrZero(usage.output_tokens);
    const reasoning = numOrZero(usage.reasoning_output_tokens);
    if (output === 0 && reasoning > 0) {
      output = reasoning;
    } else if (
      reasoning > 0 &&
      typeof usage.total_tokens === "number" &&
      rawIn + output + reasoning === usage.total_tokens
    ) {
      output += reasoning;
    }
    return {
      uncached_input_tokens: uncachedInput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: 0,
      output_tokens: output,
    };
  }

  return null;
}

function normalizeCodexRawTotals(u) {
  if (!u || typeof u !== "object") return null;
  const rawIn = numOrZero(u.input_tokens);
  const cacheRead = numOrZero(
    u.cached_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cached_tokens
  );
  let output = numOrZero(u.output_tokens);
  const reasoning = numOrZero(u.reasoning_output_tokens);
  if (output === 0 && reasoning > 0) {
    output = reasoning;
  } else if (
    reasoning > 0 &&
    typeof u.total_tokens === "number" &&
    rawIn + output + reasoning === u.total_tokens
  ) {
    output += reasoning;
  }
  return { rawIn, cacheRead, output };
}

function extractEntryModel(obj) {
  const candidates = [
    obj.model,
    obj.model_name,
    obj.metadata?.model,
    obj.message?.model,
    obj.response?.model,
    obj.payload?.model,
    obj.payload?.info?.model,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function extractEntryTimestamp(obj) {
  const candidates = [
    obj.timestamp,
    obj.created_at,
    obj.createdAt,
    obj.recorded_at,
    obj.time,
    obj.metadata?.timestamp,
    obj.payload?.timestamp,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && !Number.isNaN(Date.parse(c))) {
      return new Date(c).toISOString();
    }
    if (typeof c === "number" && Number.isFinite(c) && c > 1e12) {
      return new Date(c).toISOString();
    }
  }
  return null;
}

function extractMessageDedupId(obj) {
  const candidates = [
    obj.message?.id,
    obj.requestId,
    obj.request_id,
    obj.responseId,
    obj.response_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function addToModelBucket(map, modelName, usage) {
  const key = modelName || "unknown";
  let cur = map.get(key);
  if (!cur) {
    cur = {
      model: key,
      uncached_input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
    };
    map.set(key, cur);
  }
  cur.uncached_input_tokens += usage.uncached_input_tokens;
  cur.cache_read_tokens += usage.cache_read_tokens;
  cur.cache_write_tokens += usage.cache_write_tokens;
  cur.output_tokens += usage.output_tokens;
}

/**
 * Async streaming parser for local agent JSONL transcripts
 * (Antigravity, Claude Code, Gemini CLI, OpenAI / Codex).
 *
 * Returns `{ record, skipped_lines, warnings, steps_count }`.
 */
export async function parseTranscriptJsonl(
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
  } = {}
) {
  const absPath = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new Error(`Transcript file not found: ${absPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Transcript path is not a regular file: ${absPath}`);
  }

  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(absPath);
  stream.on("data", (chunk) => {
    hash.update(chunk);
  });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const warnings = [];
  let skippedLines = 0;
  let stepsCount = 0;
  let lineNumber = 0;
  let lastSeenModel = null;
  let lastTimestamp = null;
  let sawAnyUsage = false;

  // Streaming chunk dedup by message.id / requestId
  const dedupedMessages = new Map();
  // Direct (non-chunked) per-model accumulator
  const directModelBuckets = new Map();
  // Codex cumulative tracker
  let prevCodexTotal = null;

  try {
    for await (const line of rl) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        skippedLines += 1;
        warnings.push(`Skipped malformed JSON on line ${lineNumber}: ${err.message}`);
        continue;
      }

      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        skippedLines += 1;
        warnings.push(`Skipped non-object JSON entry on line ${lineNumber}.`);
        continue;
      }

      stepsCount += 1;

      const ts = extractEntryTimestamp(obj);
      if (ts) lastTimestamp = ts;

      const lineModel = extractEntryModel(obj);
      if (lineModel) lastSeenModel = lineModel;

      const activeModel = modelOverride || lineModel || lastSeenModel || "unknown";

      // Check Codex token_count info shape (`payload.info` or `info`)
      const codexInfo = obj.payload?.info || obj.info || null;
      if (
        codexInfo &&
        typeof codexInfo === "object" &&
        (codexInfo.total_token_usage || codexInfo.last_token_usage)
      ) {
        const currTotal = normalizeCodexRawTotals(codexInfo.total_token_usage);
        const lastUsage = codexInfo.last_token_usage
          ? normalizeUsageObject(codexInfo.last_token_usage)
          : null;

        if (currTotal) {
          const isDuplicateSnapshot =
            prevCodexTotal !== null &&
            currTotal.rawIn === prevCodexTotal.rawIn &&
            currTotal.cacheRead === prevCodexTotal.cacheRead &&
            currTotal.output === prevCodexTotal.output;

          if (isDuplicateSnapshot) {
            continue;
          }

          if (lastUsage) {
            addToModelBucket(directModelBuckets, activeModel, lastUsage);
            sawAnyUsage = true;
          } else {
            const resetDetected =
              prevCodexTotal !== null &&
              (currTotal.rawIn < prevCodexTotal.rawIn || currTotal.output < prevCodexTotal.output);
            const base = prevCodexTotal && !resetDetected ? prevCodexTotal : { rawIn: 0, cacheRead: 0, output: 0 };
            const deltaRawIn = Math.max(0, currTotal.rawIn - base.rawIn);
            const deltaCacheRead = Math.max(0, currTotal.cacheRead - base.cacheRead);
            const deltaOutput = Math.max(0, currTotal.output - base.output);
            addToModelBucket(directModelBuckets, activeModel, {
              uncached_input_tokens: Math.max(0, deltaRawIn - deltaCacheRead),
              cache_read_tokens: deltaCacheRead,
              cache_write_tokens: 0,
              output_tokens: deltaOutput,
            });
            sawAnyUsage = true;
          }
          prevCodexTotal = currTotal;
          continue;
        }

        if (lastUsage) {
          const msgId = extractMessageDedupId(obj);
          if (msgId) {
            const prev = dedupedMessages.get(msgId);
            if (!prev) {
              dedupedMessages.set(msgId, { model: activeModel, ...lastUsage });
            } else {
              prev.model = activeModel !== "unknown" ? activeModel : prev.model;
              prev.uncached_input_tokens = Math.max(
                prev.uncached_input_tokens,
                lastUsage.uncached_input_tokens
              );
              prev.cache_read_tokens = Math.max(prev.cache_read_tokens, lastUsage.cache_read_tokens);
              prev.cache_write_tokens = Math.max(prev.cache_write_tokens, lastUsage.cache_write_tokens);
              prev.output_tokens = Math.max(prev.output_tokens, lastUsage.output_tokens);
            }
          } else {
            addToModelBucket(directModelBuckets, activeModel, lastUsage);
          }
          sawAnyUsage = true;
          continue;
        }
      }

      // Standard usage extraction (Gemini, OpenAI, Anthropic, Antigravity)
      const rawUsage =
        obj.usage ||
        obj.token_usage ||
        obj.usageMetadata ||
        obj.message?.usage ||
        obj.response?.usage ||
        obj.response?.usageMetadata ||
        obj.metadata?.usageMetadata ||
        null;

      const normalizedUsage = normalizeUsageObject(rawUsage);
      if (!normalizedUsage) continue;

      sawAnyUsage = true;
      const msgId = extractMessageDedupId(obj);
      if (msgId) {
        const prev = dedupedMessages.get(msgId);
        if (!prev) {
          dedupedMessages.set(msgId, { model: activeModel, ...normalizedUsage });
        } else {
          prev.model = activeModel !== "unknown" ? activeModel : prev.model;
          prev.uncached_input_tokens = Math.max(
            prev.uncached_input_tokens,
            normalizedUsage.uncached_input_tokens
          );
          prev.cache_read_tokens = Math.max(
            prev.cache_read_tokens,
            normalizedUsage.cache_read_tokens
          );
          prev.cache_write_tokens = Math.max(
            prev.cache_write_tokens,
            normalizedUsage.cache_write_tokens
          );
          prev.output_tokens = Math.max(prev.output_tokens, normalizedUsage.output_tokens);
        }
      } else {
        addToModelBucket(directModelBuckets, activeModel, normalizedUsage);
      }
    }
  } finally {
    rl.close();
  }

  const fileSha256 = hash.digest("hex");
  const sourceRef = `transcript:sha256:${fileSha256}`;

  // Merge deduped message buckets into combined per-model buckets
  const combinedBuckets = new Map();
  for (const [m, b] of directModelBuckets.entries()) {
    addToModelBucket(combinedBuckets, m, b);
  }
  for (const b of dedupedMessages.values()) {
    addToModelBucket(combinedBuckets, b.model, b);
  }

  let uncachedInputSum = 0;
  let cacheReadSum = 0;
  let cacheWriteSum = 0;
  let outputSum = 0;

  const rawBreakdown = [...combinedBuckets.values()].sort((a, b) => {
    const totA =
      a.uncached_input_tokens + a.cache_read_tokens + a.cache_write_tokens + a.output_tokens;
    const totB =
      b.uncached_input_tokens + b.cache_read_tokens + b.cache_write_tokens + b.output_tokens;
    return totB - totA || a.model.localeCompare(b.model);
  });

  for (const b of rawBreakdown) {
    uncachedInputSum += b.uncached_input_tokens;
    cacheReadSum += b.cache_read_tokens;
    cacheWriteSum += b.cache_write_tokens;
    outputSum += b.output_tokens;
  }

  const primaryModel =
    modelOverride || (rawBreakdown.length > 0 ? rawBreakdown[0].model : lastSeenModel || "unknown");

  const costDetails = sawAnyUsage
    ? estimateCostDetails(
        {
          model: primaryModel,
          uncached_input_tokens: uncachedInputSum,
          cache_read_tokens: cacheReadSum,
          cache_write_tokens: cacheWriteSum,
          output_tokens: outputSum,
          model_breakdown: rawBreakdown.length > 0 ? rawBreakdown : undefined,
        },
        pricingTable
      )
    : { cost_usd: null, fallback_used: false, warnings: [], model_breakdown: null };

  if (costDetails.warnings.length > 0) {
    warnings.push(...costDetails.warnings);
  }

  const summaryNote =
    notes || `Imported from transcript (${stepsCount} JSONL entries).`;

  const record = normalizeTelemetryRecord({
    issue_id: issueId,
    project_id: projectId,
    phase,
    recorded_at: lastTimestamp || new Date().toISOString(),
    model: primaryModel,
    estimate_points: estimatePoints,
    felt_points: feltPoints ?? estimatePoints,
    uncached_input_tokens: sawAnyUsage ? uncachedInputSum : null,
    cache_read_tokens: sawAnyUsage ? cacheReadSum : null,
    cache_write_tokens: sawAnyUsage ? cacheWriteSum : null,
    output_tokens: sawAnyUsage ? outputSum : null,
    cost_usd: costDetails.cost_usd,
    execution,
    notes: summaryNote,
    source: "transcript",
    source_ref: sourceRef,
    model_breakdown: costDetails.model_breakdown,
  });

  return {
    record,
    skipped_lines: skippedLines,
    warnings,
    steps_count: stepsCount,
  };
}
