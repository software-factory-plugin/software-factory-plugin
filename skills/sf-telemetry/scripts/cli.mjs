#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { assertNode20, isDirectRun } from "../../../lib/cli-utils.mjs";
import {
  FIBONACCI_RUBRIC,
  appendTelemetryRecords,
  normalizeFibonacci,
  normalizeTelemetryRecord,
  readTelemetryStore,
  resolveDefaultStorePath,
  validateStorePath,
} from "./schema.mjs";
import {
  estimateCostDetails,
  loadPricingTable,
  resolvePricingPath,
} from "./pricing.mjs";
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

const CLI_OPTIONS = {
  dir: { type: "string" },
  store: { type: "string" },
  pricing: { type: "string" },
  input: { type: "string" },
  issue: { type: "string" },
  project: { type: "string" },
  phase: { type: "string" },
  model: { type: "string" },
  estimate: { type: "string" },
  felt: { type: "string" },
  "uncached-input-tokens": { type: "string" },
  "cache-read-tokens": { type: "string" },
  "cache-write-tokens": { type: "string" },
  "output-tokens": { type: "string" },
  "cost-usd": { type: "string" },
  execution: { type: "string" },
  "rework-count": { type: "string" },
  "review-verdict": { type: "string" },
  notes: { type: "string" },
  "source-ref": { type: "string" },
  since: { type: "string" },
  json: { type: "boolean", default: false },
  markdown: { type: "boolean", default: false },
  ascii: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

function printHelp() {
  const usage = [
    "Usage: node cli.mjs <command> [options]",
    "",
    "Commands:",
    "  size-check (alias: size) --estimate <1|2|3|5|8>  Validate Fibonacci size & enforce 8-pt split gate",
    "  log [options]                                    Record a v2 telemetry entry to the out-of-repo JSONL store",
    "  import-bootstrap --input <file>                  Parse Linear Bootstrap Telemetry JSON/Markdown export",
    "  import-transcript --input <jsonl>                Stream-parse token/model usage from local agent JSONL transcript",
    "  report [--json|--markdown|--ascii]               Generate Fibonacci calibration & blowup report",
    "  format-comment [options]                         Print canonical Linear closing Telemetry comment",
    "",
    "Common Options:",
    "  --dir <path>                      Consumer workspace root (for default hashed out-of-repo store)",
    "  --store <path>                    Explicit out-of-repo .jsonl store path (overrides default ~/.config/...)",
    "  --pricing <path>                  Optional custom model pricing JSON override (also honors SF_TELEMETRY_PRICING)",
    "  --issue <id>                      Issue ID (e.g. SOF-26)",
    "  --project <id>                    Optional project ID filter/field (e.g. P-SOF-6)",
    "  --phase <name>                    Optional pipeline phase filter/field (vision, prd, architecture, ...)",
    "  --model <name>                    Model name filter/field (e.g. 'Gemini 4 Neon (High)')",
    "  --since <iso-date>                Filter report records recorded on/after ISO timestamp",
    "  --estimate <n>                    Fibonacci estimate (1, 2, 3, 5, 8)",
    "  --felt <n>                        Actual felt Fibonacci size (1, 2, 3, 5, 8)",
    "  --uncached-input-tokens <n>       Uncached input token count",
    "  --cache-read-tokens <n>           Cache read input token count",
    "  --cache-write-tokens <n>          Cache write/creation input token count",
    "  --output-tokens <n>               Output token count (including reasoning/thinking tokens)",
    "  --cost-usd <n>                    Explicit USD cost (e.g. \"$1.25\"; auto-estimated if omitted & tokens given)",
    "  --execution <mode>                smooth | first-pass | minor_rework | major_rework | blocked",
    "  --rework-count <n>                Integer rework cycles",
    "  --review-verdict <v>              PASS | FAIL",
    "  --notes <text>                    One-line cause/takeaway",
    "  --source-ref <ref>                Optional stable source reference for idempotent upsert",
    "  --dry-run                         Parse without writing to the store",
    "  --strict                          Fail report on corrupt JSONL lines instead of lenient recovery",
    "  --json / --markdown / --ascii     Output format",
    "  -h, --help                        Show help",
  ];
  process.stdout.write(usage.join("\n") + "\n");
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { command: "help", flags: {} };
  }
  const { values, positionals } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    return { command: "help", flags: {} };
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }

  return { command: positionals[0], flags: values };
}

function resolveStore(flags) {
  const workspaceRoot = flags.dir || process.cwd();
  if (flags.store) {
    return validateStorePath(flags.store, { workspaceRoot });
  }
  return resolveDefaultStorePath(workspaceRoot);
}

function buildRecordFromFlags(flags, pricingTable) {
  const model = flags.model || "unknown";
  const initial = normalizeTelemetryRecord({
    issue_id: flags.issue,
    project_id: flags.project ?? null,
    phase: flags.phase ?? null,
    model,
    estimate_points: flags.estimate,
    felt_points: flags.felt !== undefined ? flags.felt : flags.estimate,
    uncached_input_tokens: flags["uncached-input-tokens"] ?? null,
    cache_read_tokens: flags["cache-read-tokens"] ?? null,
    cache_write_tokens: flags["cache-write-tokens"] ?? null,
    output_tokens: flags["output-tokens"] ?? null,
    cost_usd: flags["cost-usd"] ?? null,
    execution: flags.execution ?? "smooth",
    rework_count: flags["rework-count"] ?? null,
    review_verdict: flags["review-verdict"] ?? null,
    notes: flags.notes ?? "",
    source: "manual",
    source_ref: flags["source-ref"] ?? null,
  });

  const warnings = [];
  if (initial.cost_usd === null) {
    const costDetails = estimateCostDetails(initial, pricingTable);
    if (costDetails.warnings.length > 0) {
      warnings.push(...costDetails.warnings);
    }
    if (costDetails.cost_usd !== null) {
      initial.cost_usd = costDetails.cost_usd;
    }
  }

  return { record: initial, warnings };
}

function emitWarningsStderr(warnings) {
  for (const w of warnings) {
    process.stderr.write(`Warning: ${w}\n`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  assertNode20();
  const { command, flags } = parseCliArgs(argv);
  if (command === "help") {
    printHelp();
    return 0;
  }

  if (command === "size-check" || command === "size") {
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
      process.stdout.write(`${pts} pts [${result.status}]: ${result.rubric}\n`);
    }
    if (mustSplit) {
      process.exitCode = 2;
      return 2;
    }
    return 0;
  }

  const pricingTable = loadPricingTable(flags.pricing || null);
  const workspaceRoot = flags.dir || process.cwd();

  if (command === "format-comment") {
    const { record, warnings } = buildRecordFromFlags(flags, pricingTable);
    emitWarningsStderr(warnings);
    process.stdout.write(formatLinearTelemetryComment(record) + "\n");
    return 0;
  }

  const storePath = resolveStore(flags);

  if (command === "log") {
    const { record, warnings } = buildRecordFromFlags(flags, pricingTable);
    const res = flags["dry-run"]
      ? { written: 0, updated: 0, skipped: 0, warnings: [], storePath }
      : appendTelemetryRecords(storePath, [record], {
          deduplicate: Boolean(record.source_ref),
          upsert: true,
          workspaceRoot,
        });
    const allWarnings = [...warnings, ...(res.warnings || [])];
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ ...res, warnings: allWarnings, record }, null, 2) + "\n"
      );
    } else {
      emitWarningsStderr(allWarnings);
      process.stdout.write(
        `Logged ${record.issue_id} (${record.estimate_points} -> ${record.felt_points} pts, cost=${record.cost_usd !== null ? `$${record.cost_usd}` : "n/a"}) to ${res.storePath}\n`
      );
    }
    return 0;
  }

  if (command === "import-bootstrap") {
    if (!flags.input) throw new Error("import-bootstrap requires --input <file>");
    const absInput = path.resolve(flags.input);
    const raw = fs.readFileSync(absInput, "utf8");
    let parsedRecords = [];
    let parseWarnings = [];

    if (absInput.endsWith(".json") || raw.trim().startsWith("[") || raw.trim().startsWith("{")) {
      const parsed = parseBootstrapExport(JSON.parse(raw), { pricingTable });
      parsedRecords = parsed.records;
      parseWarnings = parsed.warnings;
    } else {
      const rec = parseBootstrapComment(raw, {
        issueId: flags.issue || path.basename(absInput, path.extname(absInput)),
        projectId: flags.project || null,
        phase: flags.phase || null,
        pricingTable,
      });
      if (rec) parsedRecords = [rec];
    }

    const res = flags["dry-run"]
      ? { written: 0, updated: 0, skipped: 0, warnings: [], parsed: parsedRecords.length, storePath }
      : {
          ...appendTelemetryRecords(storePath, parsedRecords, {
            deduplicate: true,
            upsert: true,
            workspaceRoot,
          }),
          parsed: parsedRecords.length,
        };
    const allWarnings = [...parseWarnings, ...(res.warnings || [])];

    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ ...res, warnings: allWarnings, records: parsedRecords }, null, 2) + "\n"
      );
    } else {
      emitWarningsStderr(allWarnings);
      process.stdout.write(
        `Imported ${res.written} new, ${res.updated} updated (parsed ${parsedRecords.length}, skipped ${res.skipped} duplicate(s)) into ${res.storePath}\n`
      );
    }
    return 0;
  }

  if (command === "import-transcript") {
    if (!flags.input) throw new Error("import-transcript requires --input <transcript.jsonl>");
    const parsed = await parseTranscriptJsonl(flags.input, {
      issueId: flags.issue,
      projectId: flags.project || null,
      phase: flags.phase || null,
      estimatePoints: flags.estimate,
      feltPoints: flags.felt !== undefined ? flags.felt : flags.estimate,
      modelOverride: flags.model || null,
      execution: flags.execution || "smooth",
      notes: flags.notes || "",
      pricingTable,
    });

    const res = flags["dry-run"]
      ? { written: 0, updated: 0, skipped: 0, warnings: [], storePath }
      : appendTelemetryRecords(storePath, [parsed.record], {
          deduplicate: true,
          upsert: true,
          workspaceRoot,
        });

    const allWarnings = [...parsed.warnings, ...(res.warnings || [])];
    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ...res,
            skipped_lines: parsed.skipped_lines,
            steps_count: parsed.steps_count,
            warnings: allWarnings,
            record: parsed.record,
          },
          null,
          2
        ) + "\n"
      );
    } else {
      emitWarningsStderr(allWarnings);
      process.stdout.write(
        `Imported transcript for ${parsed.record.issue_id} (model=${parsed.record.model}, cost=${parsed.record.cost_usd !== null ? `$${parsed.record.cost_usd}` : "n/a"}, written=${res.written}, updated=${res.updated}) into ${res.storePath}\n`
      );
    }
    return 0;
  }

  if (command === "report") {
    const storeResult = readTelemetryStore(storePath, {
      lenient: !flags.strict,
      workspaceRoot,
    });
    const pricingInfo = resolvePricingPath(flags.pricing || null);
    const shouldReprice = pricingInfo.source !== "builtin";
    const report = buildCalibrationReport(storeResult.records, {
      project: flags.project || null,
      phase: flags.phase || null,
      model: flags.model || null,
      since: flags.since || null,
      pricingTable: shouldReprice ? pricingTable : null,
    });
    const allWarnings = [...storeResult.warnings, ...report.warnings];
    report.warnings = allWarnings;
    report.skipped_lines = storeResult.skipped_lines;

    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else if (flags.markdown) {
      emitWarningsStderr(allWarnings);
      process.stdout.write(formatReportMarkdown(report) + "\n");
    } else {
      emitWarningsStderr(allWarnings);
      process.stdout.write(formatReportAscii(report) + "\n");
    }
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
