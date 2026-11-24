#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  FIBONACCI_RUBRIC,
  appendTelemetryRecords,
  normalizeFibonacci,
  normalizeTelemetryRecord,
  readTelemetryStore,
  resolveDefaultStorePath,
} from "./schema.mjs";
import { estimateCostUsd, loadPricingTable } from "./pricing.mjs";
import {
  parseBootstrapComment,
  parseBootstrapExport,
  parseTranscriptJsonl,
} from "./parsers.mjs";
import {
  buildCalibrationReport,
  formatLinearTelemetryComment,
  formatReportAscii,
  formatReportMarkdown,
} from "./calibrator.mjs";

function printHelp() {
  const usage = [
    "Usage: node cli.mjs <command> [options]",
    "",
    "Commands:",
    "  size-check --estimate <1|2|3|5|8>     Validate Fibonacci size & enforce 8-pt split gate",
    "  log [options]                         Record a telemetry entry to the out-of-repo JSONL store",
    "  import-bootstrap --input <file>       Parse Linear Bootstrap Telemetry JSON/Markdown export",
    "  import-transcript --input <jsonl>     Extract token/model usage from local agent JSONL transcript",
    "  report [--json|--markdown|--ascii]    Generate Fibonacci calibration & blowup report",
    "  format-comment [options]              Print canonical Linear closing Telemetry comment",
    "",
    "Common Options:",
    "  --dir <path>            Consumer workspace root (for default out-of-repo store slug)",
    "  --store <path>          Explicit JSONL store path (overrides default ~/.config/...)",
    "  --pricing <path>        Optional custom model pricing JSON override",
    "  --issue <id>            Issue ID (e.g. SOF-26)",
    "  --project <id>          Optional project ID (e.g. P-SOF-6)",
    "  --phase <name>          Optional pipeline phase (vision, prd, architecture, ...)",
    "  --model <name>          Model name (e.g. 'Gemini 4 Neon (High)')",
    "  --estimate <n>          Fibonacci estimate (1, 2, 3, 5, 8)",
    "  --felt <n>              Actual felt Fibonacci size (1, 2, 3, 5, 8)",
    "  --input-tokens <n>      Input token count",
    "  --output-tokens <n>     Output token count",
    "  --cached-tokens <n>     Cached input token count",
    "  --cost-usd <n>          Explicit USD cost (auto-estimated if omitted & tokens given)",
    "  --execution <mode>      smooth | minor_rework | major_rework",
    "  --rework-count <n>      Integer rework cycles",
    "  --review-verdict <v>    PASS | FAIL",
    "  --notes <text>          One-line cause/takeaway",
    "  --json / --markdown / --ascii   Output format",
    "  -h, --help              Show help",
  ];
  process.stdout.write(usage.join("\n") + "\n");
}

export function parseCliArgs(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { command: "help", flags: {} };
  }
  const command = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      return { command: "help", flags: {} };
    }
    if (arg === "--json" || arg === "--markdown" || arg === "--ascii" || arg === "--dry-run") {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`Missing value for --${key}`);
        }
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return { command, flags };
}

function resolveStore(flags) {
  if (flags.store) return path.resolve(flags.store);
  return resolveDefaultStorePath(flags.dir || process.cwd());
}

function buildRecordFromFlags(flags, pricingTable) {
  const model = flags.model || "unknown";
  const input_tokens = flags["input-tokens"] !== undefined ? Number(flags["input-tokens"]) : null;
  const output_tokens = flags["output-tokens"] !== undefined ? Number(flags["output-tokens"]) : null;
  const cached_tokens = flags["cached-tokens"] !== undefined ? Number(flags["cached-tokens"]) : null;

  let cost_usd = flags["cost-usd"] !== undefined ? Number(flags["cost-usd"]) : null;
  if (cost_usd === null) {
    cost_usd = estimateCostUsd({ model, input_tokens, output_tokens, cached_tokens }, pricingTable);
  }

  return normalizeTelemetryRecord({
    issue_id: flags.issue,
    project_id: flags.project || null,
    phase: flags.phase || null,
    model,
    estimate_points: flags.estimate,
    felt_points: flags.felt ?? flags.estimate,
    input_tokens,
    output_tokens,
    cached_tokens,
    cost_usd,
    execution: flags.execution || "smooth",
    rework_count: flags["rework-count"],
    review_verdict: flags["review-verdict"] || null,
    notes: flags.notes || "",
    source: "manual",
  });
}

async function main() {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  if (command === "help") {
    printHelp();
    process.exit(0);
  }

  const pricingTable = loadPricingTable(flags.pricing || null);
  const storePath = resolveStore(flags);

  if (command === "size-check") {
    const pts = normalizeFibonacci(flags.estimate, "estimate");
    const mustSplit = pts === 8;
    const result = {
      estimate_points: pts,
      rubric: FIBONACCI_RUBRIC[pts],
      must_split: mustSplit,
      status: mustSplit ? "SPLIT_REQUIRED" : "OK",
    };
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(
        `${pts} pts [${result.status}]: ${result.rubric}\n`
      );
    }
    if (mustSplit) process.exit(2);
    return;
  }

  if (command === "format-comment") {
    const rec = buildRecordFromFlags(flags, pricingTable);
    process.stdout.write(formatLinearTelemetryComment(rec) + "\n");
    return;
  }

  if (command === "log") {
    const rec = buildRecordFromFlags(flags, pricingTable);
    const res = appendTelemetryRecords(storePath, [rec], { deduplicate: false });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ...res, record: rec }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Logged ${rec.issue_id} (${rec.estimate_points} -> ${rec.felt_points} pts, cost=${rec.cost_usd !== null ? `$${rec.cost_usd}` : "n/a"}) to ${res.storePath}\n`
      );
    }
    return;
  }

  if (command === "import-bootstrap") {
    if (!flags.input) throw new Error("import-bootstrap requires --input <file>");
    const absInput = path.resolve(flags.input);
    const raw = fs.readFileSync(absInput, "utf8");
    let parsedRecords = [];
    if (absInput.endsWith(".json") || raw.trim().startsWith("[") || raw.trim().startsWith("{")) {
      parsedRecords = parseBootstrapExport(JSON.parse(raw), { pricingTable });
    } else {
      const rec = parseBootstrapComment(raw, {
        issueId: flags.issue || path.basename(absInput, path.extname(absInput)),
        projectId: flags.project || null,
        pricingTable,
      });
      if (rec) parsedRecords = [rec];
    }
    const res = flags["dry-run"]
      ? { written: 0, skipped: 0, parsed: parsedRecords.length, storePath }
      : {
          ...appendTelemetryRecords(storePath, parsedRecords, { deduplicate: true }),
          parsed: parsedRecords.length,
        };
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ...res, records: parsedRecords }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Imported ${res.written} record(s) (parsed ${parsedRecords.length}, skipped ${res.skipped} duplicate(s)) into ${res.storePath}\n`
      );
    }
    return;
  }

  if (command === "import-transcript") {
    if (!flags.input) throw new Error("import-transcript requires --input <transcript.jsonl>");
    const rec = parseTranscriptJsonl(flags.input, {
      issueId: flags.issue,
      projectId: flags.project || null,
      phase: flags.phase || null,
      estimatePoints: flags.estimate,
      feltPoints: flags.felt ?? flags.estimate,
      modelOverride: flags.model || null,
      execution: flags.execution || "smooth",
      notes: flags.notes || "",
      pricingTable,
    });
    const res = flags["dry-run"]
      ? { written: 0, skipped: 0, storePath }
      : appendTelemetryRecords(storePath, [rec], { deduplicate: false });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ...res, record: rec }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Imported transcript for ${rec.issue_id} (model=${rec.model}, cost=${rec.cost_usd !== null ? `$${rec.cost_usd}` : "n/a"}) into ${res.storePath}\n`
      );
    }
    return;
  }

  if (command === "report") {
    const records = readTelemetryStore(storePath);
    const report = buildCalibrationReport(records);
    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else if (flags.markdown) {
      process.stdout.write(formatReportMarkdown(report) + "\n");
    } else {
      process.stdout.write(formatReportAscii(report) + "\n");
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
