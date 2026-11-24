import fs from "node:fs";
import path from "node:path";

/**
 * Default offline reference pricing table (USD per 1,000,000 tokens).
 * Overrideable at runtime via --pricing <custom.json>.
 */
export const DEFAULT_PRICING_TABLE = Object.freeze([
  { match: "gemini 4", inputPer1M: 2.5, outputPer1M: 12.0, cachedPer1M: 0.625 },
  { match: "gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 10.0, cachedPer1M: 0.31 },
  { match: "gemini 2.5 pro", inputPer1M: 1.25, outputPer1M: 10.0, cachedPer1M: 0.31 },
  { match: "gemini-2.5-flash", inputPer1M: 0.15, outputPer1M: 0.6, cachedPer1M: 0.0375 },
  { match: "gemini 2.5 flash", inputPer1M: 0.15, outputPer1M: 0.6, cachedPer1M: 0.0375 },
  { match: "claude opus", inputPer1M: 15.0, outputPer1M: 75.0, cachedPer1M: 1.5 },
  { match: "claude-opus", inputPer1M: 15.0, outputPer1M: 75.0, cachedPer1M: 1.5 },
  { match: "claude sonnet", inputPer1M: 3.0, outputPer1M: 15.0, cachedPer1M: 0.3 },
  { match: "claude-sonnet", inputPer1M: 3.0, outputPer1M: 15.0, cachedPer1M: 0.3 },
  { match: "claude haiku", inputPer1M: 0.8, outputPer1M: 4.0, cachedPer1M: 0.08 },
  { match: "claude-haiku", inputPer1M: 0.8, outputPer1M: 4.0, cachedPer1M: 0.08 },
  { match: "gpt-4.1", inputPer1M: 2.0, outputPer1M: 8.0, cachedPer1M: 0.5 },
  { match: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10.0, cachedPer1M: 1.25 },
  { match: "o3", inputPer1M: 2.0, outputPer1M: 8.0, cachedPer1M: 0.5 },
]);

export function loadPricingTable(customPricingPath = null) {
  if (!customPricingPath) return [...DEFAULT_PRICING_TABLE];
  const absPath = path.resolve(customPricingPath);
  const parsed = JSON.parse(fs.readFileSync(absPath, "utf8"));
  const customEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.models)
      ? parsed.models
      : Object.entries(parsed || {}).map(([match, rates]) => ({
          match,
          ...(rates || {}),
        }));
  return [...customEntries, ...DEFAULT_PRICING_TABLE];
}

export function lookupModelPricing(modelName, pricingTable = DEFAULT_PRICING_TABLE) {
  if (typeof modelName !== "string" || !modelName.trim()) return null;
  const lowered = modelName.trim().toLowerCase();
  for (const entry of pricingTable) {
    if (!entry || typeof entry.match !== "string") continue;
    if (lowered.includes(entry.match.toLowerCase())) {
      return {
        match: entry.match,
        inputPer1M: Number(entry.inputPer1M) || 0,
        outputPer1M: Number(entry.outputPer1M) || 0,
        cachedPer1M:
          entry.cachedPer1M !== undefined
            ? Number(entry.cachedPer1M) || 0
            : (Number(entry.inputPer1M) || 0) * 0.25,
      };
    }
  }
  return null;
}

/**
 * Estimate USD cost from token counts using the offline pricing table.
 * Returns null if no token counts are present or no model pricing matches.
 */
export function estimateCostUsd(
  { model, input_tokens = null, output_tokens = null, cached_tokens = null },
  pricingTable = DEFAULT_PRICING_TABLE
) {
  const hasAny =
    (typeof input_tokens === "number" && input_tokens > 0) ||
    (typeof output_tokens === "number" && output_tokens > 0) ||
    (typeof cached_tokens === "number" && cached_tokens > 0);
  if (!hasAny) return null;

  const rates = lookupModelPricing(model, pricingTable);
  if (!rates) return null;

  const inTok = typeof input_tokens === "number" ? input_tokens : 0;
  const outTok = typeof output_tokens === "number" ? output_tokens : 0;
  const cachedTok = typeof cached_tokens === "number" ? cached_tokens : 0;

  const usd =
    (inTok * rates.inputPer1M +
      outTok * rates.outputPer1M +
      cachedTok * rates.cachedPer1M) /
    1_000_000;

  return Math.round(usd * 1e6) / 1e6;
}
