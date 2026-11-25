import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const PRICING_TABLE_UPDATED = "2026-04-01";

/**
 * Normalize model IDs for separator-independent matching:
 * collapses runs of hyphens, underscores, and whitespace into single hyphens and lowercases.
 */
export function normalizeModelId(modelName) {
  if (typeof modelName !== "string") return "";
  return modelName
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function assertNonNegativeRate(value, fieldName, matchLabel) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid pricing rate "${fieldName}" for model "${matchLabel}": expected finite non-negative number (received ${String(value)})`
    );
  }
  return value;
}

/**
 * Strictly validate and normalize a single pricing rule entry.
 */
export function validatePricingEntry(entry, { priority = 0 } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid pricing entry: expected an object");
  }
  if (typeof entry.match !== "string" || !entry.match.trim()) {
    throw new Error("Invalid pricing entry: 'match' must be a non-empty string");
  }
  const match = entry.match.trim();
  const normalizedMatch = normalizeModelId(match);
  if (!normalizedMatch) {
    throw new Error(`Invalid pricing entry match "${match}": normalizes to empty string`);
  }

  const inputPer1M = assertNonNegativeRate(entry.inputPer1M, "inputPer1M", match);
  const outputPer1M = assertNonNegativeRate(entry.outputPer1M, "outputPer1M", match);
  const cacheReadPer1M =
    entry.cacheReadPer1M !== undefined
      ? assertNonNegativeRate(entry.cacheReadPer1M, "cacheReadPer1M", match)
      : Math.round(inputPer1M * 0.25 * 1e6) / 1e6;
  const cacheWritePer1M =
    entry.cacheWritePer1M !== undefined
      ? assertNonNegativeRate(entry.cacheWritePer1M, "cacheWritePer1M", match)
      : 0;

  return Object.freeze({
    match,
    normalizedMatch,
    inputPer1M,
    cacheReadPer1M,
    cacheWritePer1M,
    outputPer1M,
    priority,
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortPricingEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      b.normalizedMatch.length - a.normalizedMatch.length ||
      (b.priority || 0) - (a.priority || 0) ||
      a.normalizedMatch.localeCompare(b.normalizedMatch)
  );
}

/**
 * Default offline reference pricing table (USD per 1,000,000 tokens).
 * Sorted by normalized pattern length descending so specific variants (-mini, -nano, -lite, -pro)
 * are never shadowed by shorter prefixes.
 */
const RAW_DEFAULT_PRICING = [
  // Google Gemini
  { match: "gemini-4", inputPer1M: 2.5, cacheReadPer1M: 0.625, cacheWritePer1M: 0, outputPer1M: 12.0 },
  { match: "gemini-2.5-pro", inputPer1M: 1.25, cacheReadPer1M: 0.3125, cacheWritePer1M: 0, outputPer1M: 10.0 },
  { match: "gemini-2.5-flash-lite", inputPer1M: 0.1, cacheReadPer1M: 0.025, cacheWritePer1M: 0, outputPer1M: 0.4 },
  { match: "gemini-2.5-flash", inputPer1M: 0.15, cacheReadPer1M: 0.0375, cacheWritePer1M: 0, outputPer1M: 0.6 },
  { match: "gemini-2.0-flash-lite", inputPer1M: 0.075, cacheReadPer1M: 0.01875, cacheWritePer1M: 0, outputPer1M: 0.3 },
  { match: "gemini-2.0-flash", inputPer1M: 0.1, cacheReadPer1M: 0.025, cacheWritePer1M: 0, outputPer1M: 0.4 },

  // Anthropic Claude (1.25x cache write, 0.1x cache read)
  { match: "claude-opus-4.6", inputPer1M: 5.0, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25, outputPer1M: 25.0 },
  { match: "claude-opus-4-6", inputPer1M: 5.0, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25, outputPer1M: 25.0 },
  { match: "claude-opus-4.5", inputPer1M: 5.0, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25, outputPer1M: 25.0 },
  { match: "claude-opus-4-5", inputPer1M: 5.0, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25, outputPer1M: 25.0 },
  { match: "claude-opus-4.1", inputPer1M: 15.0, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75, outputPer1M: 75.0 },
  { match: "claude-opus-4-1", inputPer1M: 15.0, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75, outputPer1M: 75.0 },
  { match: "claude-opus-4", inputPer1M: 15.0, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75, outputPer1M: 75.0 },
  { match: "claude-4-opus", inputPer1M: 15.0, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75, outputPer1M: 75.0 },
  { match: "claude-opus", inputPer1M: 15.0, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75, outputPer1M: 75.0 },

  { match: "claude-sonnet-4.6", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-sonnet-4-6", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-sonnet-4.5", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-sonnet-4-5", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-sonnet-4", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-4-sonnet", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-3.7-sonnet", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-3-7-sonnet", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-3.5-sonnet", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-3-5-sonnet", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },
  { match: "claude-sonnet", inputPer1M: 3.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, outputPer1M: 15.0 },

  { match: "claude-haiku-4.5", inputPer1M: 1.0, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25, outputPer1M: 5.0 },
  { match: "claude-haiku-4-5", inputPer1M: 1.0, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25, outputPer1M: 5.0 },
  { match: "claude-haiku-4", inputPer1M: 1.0, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25, outputPer1M: 5.0 },
  { match: "claude-3.5-haiku", inputPer1M: 0.8, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0, outputPer1M: 4.0 },
  { match: "claude-3-5-haiku", inputPer1M: 0.8, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0, outputPer1M: 4.0 },
  { match: "claude-haiku", inputPer1M: 0.8, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0, outputPer1M: 4.0 },

  // OpenAI GPT, o-series & Codex
  { match: "gpt-5-nano", inputPer1M: 0.05, cacheReadPer1M: 0.005, cacheWritePer1M: 0, outputPer1M: 0.4 },
  { match: "gpt-5-mini", inputPer1M: 0.25, cacheReadPer1M: 0.025, cacheWritePer1M: 0, outputPer1M: 2.0 },
  { match: "gpt-5", inputPer1M: 1.25, cacheReadPer1M: 0.125, cacheWritePer1M: 0, outputPer1M: 10.0 },
  { match: "gpt-4.1-nano", inputPer1M: 0.1, cacheReadPer1M: 0.025, cacheWritePer1M: 0, outputPer1M: 0.4 },
  { match: "gpt-4.1-mini", inputPer1M: 0.4, cacheReadPer1M: 0.1, cacheWritePer1M: 0, outputPer1M: 1.6 },
  { match: "gpt-4.1", inputPer1M: 2.0, cacheReadPer1M: 0.5, cacheWritePer1M: 0, outputPer1M: 8.0 },
  { match: "gpt-4o-mini", inputPer1M: 0.15, cacheReadPer1M: 0.075, cacheWritePer1M: 0, outputPer1M: 0.6 },
  { match: "gpt-4o", inputPer1M: 2.5, cacheReadPer1M: 1.25, cacheWritePer1M: 0, outputPer1M: 10.0 },
  { match: "o4-mini", inputPer1M: 1.1, cacheReadPer1M: 0.275, cacheWritePer1M: 0, outputPer1M: 4.4 },
  { match: "o3-pro", inputPer1M: 20.0, cacheReadPer1M: 5.0, cacheWritePer1M: 0, outputPer1M: 80.0 },
  { match: "o3-mini", inputPer1M: 1.1, cacheReadPer1M: 0.55, cacheWritePer1M: 0, outputPer1M: 4.4 },
  { match: "o3", inputPer1M: 2.0, cacheReadPer1M: 0.5, cacheWritePer1M: 0, outputPer1M: 8.0 },
  { match: "o1-pro", inputPer1M: 150.0, cacheReadPer1M: 75.0, cacheWritePer1M: 0, outputPer1M: 600.0 },
  { match: "o1-mini", inputPer1M: 1.1, cacheReadPer1M: 0.55, cacheWritePer1M: 0, outputPer1M: 4.4 },
  { match: "o1", inputPer1M: 15.0, cacheReadPer1M: 7.5, cacheWritePer1M: 0, outputPer1M: 60.0 },
  { match: "codex-mini", inputPer1M: 1.5, cacheReadPer1M: 0.375, cacheWritePer1M: 0, outputPer1M: 6.0 },
];

export const DEFAULT_PRICING_TABLE = Object.freeze(
  sortPricingEntries(RAW_DEFAULT_PRICING.map((entry) => validatePricingEntry(entry, { priority: 0 })))
);

/**
 * Resolve custom pricing file path in precedence order:
 * 1. Explicit `customPricingPath` (`--pricing`)
 * 2. `SF_TELEMETRY_PRICING` env var
 * 3. Default `~/.config/software-factory/pricing.json` (only if present)
 */
export function resolvePricingPath(
  customPricingPath = null,
  { env = process.env, homedir = os.homedir() } = {}
) {
  if (typeof customPricingPath === "string" && customPricingPath.trim()) {
    return { path: path.resolve(customPricingPath.trim()), required: true, source: "flag" };
  }
  if (typeof env.SF_TELEMETRY_PRICING === "string" && env.SF_TELEMETRY_PRICING.trim()) {
    return { path: path.resolve(env.SF_TELEMETRY_PRICING.trim()), required: true, source: "env" };
  }
  const xdg =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
      ? path.resolve(env.XDG_CONFIG_HOME.trim())
      : path.join(homedir, ".config");
  const defaultPath = path.join(xdg, "software-factory", "pricing.json");
  if (fs.existsSync(defaultPath)) {
    return { path: defaultPath, required: false, source: "default_file" };
  }
  return { path: null, required: false, source: "builtin" };
}

export function loadPricingTable(
  customPricingPath = null,
  { env = process.env, homedir = os.homedir() } = {}
) {
  const resolved = resolvePricingPath(customPricingPath, { env, homedir });
  if (!resolved.path) {
    return [...DEFAULT_PRICING_TABLE];
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved.path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to load pricing file "${resolved.path}": ${err.message}`);
  }

  let rawCustom;
  if (Array.isArray(parsed)) {
    rawCustom = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.models)) {
    rawCustom = parsed.models;
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    rawCustom = Object.entries(parsed).map(([match, rates]) => {
      if (!rates || typeof rates !== "object" || Array.isArray(rates)) {
        throw new Error(`Invalid pricing entry for "${match}": expected an object of rates`);
      }
      return { match, ...rates };
    });
  } else {
    throw new Error(`Invalid pricing file "${resolved.path}": expected array or object`);
  }

  const validatedCustom = rawCustom.map((entry) => validatePricingEntry(entry, { priority: 1 }));
  return sortPricingEntries([...validatedCustom, ...DEFAULT_PRICING_TABLE]);
}

function normalizeTable(pricingTable) {
  if (pricingTable === DEFAULT_PRICING_TABLE) return DEFAULT_PRICING_TABLE;
  if (!Array.isArray(pricingTable)) {
    throw new Error("Invalid pricingTable: expected an array of pricing entries");
  }
  const normalized = pricingTable.map((entry) =>
    entry && typeof entry.normalizedMatch === "string"
      ? validatePricingEntry(entry, { priority: entry.priority || 0 })
      : validatePricingEntry(entry, { priority: 0 })
  );
  return sortPricingEntries(normalized);
}

/**
 * Look up pricing rates for a model name using separator normalization,
 * specificity ordering (longest pattern first), and alphanumeric boundary matching.
 */
export function lookupModelPricing(modelName, pricingTable = DEFAULT_PRICING_TABLE) {
  const normModel = normalizeModelId(modelName);
  if (!normModel) return null;

  const table = normalizeTable(pricingTable);

  // Pass 1: exact normalized match (highest priority first)
  let exactBest = null;
  for (const entry of table) {
    if (entry.normalizedMatch === normModel) {
      if (!exactBest || (entry.priority || 0) > (exactBest.priority || 0)) {
        exactBest = entry;
      }
    }
  }
  if (exactBest) {
    return {
      match: exactBest.match,
      inputPer1M: exactBest.inputPer1M,
      cacheReadPer1M: exactBest.cacheReadPer1M,
      cacheWritePer1M: exactBest.cacheWritePer1M,
      outputPer1M: exactBest.outputPer1M,
    };
  }

  // Pass 2: specificity-ordered boundary match (table is pre-sorted by normalizedMatch.length desc, priority desc)
  for (const entry of table) {
    const boundaryRe = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(entry.normalizedMatch)}(?:$|[^a-z0-9])`);
    if (boundaryRe.test(normModel)) {
      return {
        match: entry.match,
        inputPer1M: entry.inputPer1M,
        cacheReadPer1M: entry.cacheReadPer1M,
        cacheWritePer1M: entry.cacheWritePer1M,
        outputPer1M: entry.outputPer1M,
      };
    }
  }

  return null;
}

function computeBucketUsd(
  { uncached_input_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, output_tokens = 0 },
  rates
) {
  const uncached = typeof uncached_input_tokens === "number" ? uncached_input_tokens : 0;
  const cacheRead = typeof cache_read_tokens === "number" ? cache_read_tokens : 0;
  const cacheWrite = typeof cache_write_tokens === "number" ? cache_write_tokens : 0;
  const output = typeof output_tokens === "number" ? output_tokens : 0;

  const usd =
    (uncached * rates.inputPer1M +
      cacheRead * rates.cacheReadPer1M +
      cacheWrite * rates.cacheWritePer1M +
      output * rates.outputPer1M) /
    1_000_000;

  return Math.round(usd * 1e6) / 1e6;
}

function hasPositiveTokens(bucket) {
  return (
    (typeof bucket.uncached_input_tokens === "number" && bucket.uncached_input_tokens > 0) ||
    (typeof bucket.cache_read_tokens === "number" && bucket.cache_read_tokens > 0) ||
    (typeof bucket.cache_write_tokens === "number" && bucket.cache_write_tokens > 0) ||
    (typeof bucket.output_tokens === "number" && bucket.output_tokens > 0)
  );
}

/**
 * Estimate USD cost and return explicit fallback/warning diagnostics.
 * Supports both single-model token buckets and multi-model `model_breakdown` arrays.
 */
export function estimateCostDetails(input = {}, pricingTable = DEFAULT_PRICING_TABLE) {
  const table = normalizeTable(pricingTable);
  const warnings = [];
  let fallbackUsed = false;

  if (Array.isArray(input.model_breakdown) && input.model_breakdown.length > 0) {
    let totalUsd = 0;
    let pricedAny = false;
    let missingAnyRate = false;
    const pricedBreakdown = [];

    for (const bucket of input.model_breakdown) {
      const positive = hasPositiveTokens(bucket);
      if (!positive) {
        pricedBreakdown.push({
          model: bucket.model,
          uncached_input_tokens: bucket.uncached_input_tokens ?? 0,
          cache_read_tokens: bucket.cache_read_tokens ?? 0,
          cache_write_tokens: bucket.cache_write_tokens ?? 0,
          output_tokens: bucket.output_tokens ?? 0,
          cost_usd: 0,
        });
        continue;
      }

      const rates = lookupModelPricing(bucket.model, table);
      if (!rates) {
        fallbackUsed = true;
        missingAnyRate = true;
        warnings.push(
          `Unknown model "${bucket.model}" in pricing table (updated ${PRICING_TABLE_UPDATED}); cost could not be estimated.`
        );
        pricedBreakdown.push({
          model: bucket.model,
          uncached_input_tokens: bucket.uncached_input_tokens ?? 0,
          cache_read_tokens: bucket.cache_read_tokens ?? 0,
          cache_write_tokens: bucket.cache_write_tokens ?? 0,
          output_tokens: bucket.output_tokens ?? 0,
          cost_usd: null,
        });
        continue;
      }

      const bucketCost = computeBucketUsd(bucket, rates);
      totalUsd += bucketCost;
      pricedAny = true;
      pricedBreakdown.push({
        model: bucket.model,
        uncached_input_tokens: bucket.uncached_input_tokens ?? 0,
        cache_read_tokens: bucket.cache_read_tokens ?? 0,
        cache_write_tokens: bucket.cache_write_tokens ?? 0,
        output_tokens: bucket.output_tokens ?? 0,
        cost_usd: bucketCost,
      });
    }

    return {
      cost_usd: pricedAny && !missingAnyRate ? Math.round(totalUsd * 1e6) / 1e6 : null,
      fallback_used: fallbackUsed,
      warnings,
      model_breakdown: pricedBreakdown,
    };
  }

  if (!hasPositiveTokens(input)) {
    return {
      cost_usd: null,
      fallback_used: false,
      warnings: [],
      model_breakdown: null,
    };
  }

  const rates = lookupModelPricing(input.model, table);
  if (!rates) {
    return {
      cost_usd: null,
      fallback_used: true,
      warnings: [
        `Unknown model "${String(input.model ?? "unknown")}" in pricing table (updated ${PRICING_TABLE_UPDATED}); cost could not be estimated.`,
      ],
      model_breakdown: null,
    };
  }

  return {
    cost_usd: computeBucketUsd(input, rates),
    fallback_used: false,
    warnings: [],
    model_breakdown: null,
  };
}

/**
 * Convenience wrapper returning only the estimated USD cost (or null).
 */
export function estimateCostUsd(input, pricingTable = DEFAULT_PRICING_TABLE) {
  return estimateCostDetails(input, pricingTable).cost_usd;
}
