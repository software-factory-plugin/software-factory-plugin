#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { assertNode20, isDirectRun } from "../../../lib/cli-utils.mjs";
import { analyzeWorkspace } from "./analyzer.mjs";
import {
  findDefaultWorkGraphPath,
  loadWorkGraphFile,
} from "./work-analyzer.mjs";
import { fetchLinearGraph } from "./linear-adapter.mjs";
import {
  formatAscii,
  formatMermaid,
  formatWorkAscii,
  formatWorkMermaid,
} from "./formatters.mjs";

const ALLOWED_VIEWS = new Set(["auto", "work", "pipeline"]);
const DEFAULT_POLL_MS = 30000;
const MIN_POLL_MS = 5000;

function printHelp() {
  const usage = [
    "Usage: node cli.mjs [options]",
    "",
    "Options:",
    "  --dir <path>                 Consumer workspace directory (default: cwd)",
    "  --work-graph <path>          Path to canonical work-graph v1 JSON snapshot",
    "  --linear-project <id|slug|name>  Fetch live Linear project via LINEAR_API_KEY",
    "  --linear-team <key|name>     Fetch all Linear projects in a team via LINEAR_API_KEY",
    "  --poll-ms <num>              Live Linear polling interval in ms (default: 30000, >= 5000, or 0 to disable)",
    "  --view <auto|work|pipeline>  Select view mode (default: auto)",
    "  --json                       Output v1 Graph JSON (work or pipeline)",
    "  --mermaid                    Output color-coded Mermaid DAG",
    "  --ascii                      Output terminal ASCII tech-tree (default)",
    "  --serve                      Start live local HTTP + SSE tech-tree viewer",
    "  --port <num>                 Port for --serve (0..65535, default: 4173, auto-fallback)",
    "  --no-open                    Do not auto-open browser when using --serve",
    "  -h, --help                   Show this help message",
  ];
  process.stdout.write(usage.join("\n") + "\n");
}

function readNextValue(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export function validatePort(rawValue) {
  const str = String(rawValue ?? "").trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`Invalid numeric value for --port: ${JSON.stringify(rawValue)} (expected integer 0..65535)`);
  }
  const port = Number(str);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid value for --port: ${port} (expected integer 0..65535)`);
  }
  return port;
}

export function validatePollMs(rawValue) {
  const str = String(rawValue ?? "").trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(
      `Invalid numeric value for --poll-ms: ${JSON.stringify(rawValue)} (expected 0 to disable or finite integer >= ${MIN_POLL_MS})`
    );
  }
  const ms = Number(str);
  if (!Number.isSafeInteger(ms) || (ms !== 0 && ms < MIN_POLL_MS)) {
    throw new Error(
      `Invalid value for --poll-ms: ${ms} (expected 0 to disable or finite integer >= ${MIN_POLL_MS})`
    );
  }
  return ms;
}

export function parseArgs(argv) {
  const opts = {
    dir: process.cwd(),
    workGraph: null,
    linearProject: null,
    linearTeam: null,
    pollMs: DEFAULT_POLL_MS,
    view: "auto",
    mode: "ascii",
    serve: false,
    port: 4173,
    noOpen: false,
    help: false,
  };

  let explicitMode = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--dir") {
      opts.dir = path.resolve(readNextValue(argv, i, "--dir"));
      i += 1;
    } else if (arg.startsWith("--dir=")) {
      const val = arg.slice("--dir=".length);
      if (!val) throw new Error("Missing value for --dir");
      opts.dir = path.resolve(val);
    } else if (arg === "--work-graph") {
      opts.workGraph = path.resolve(readNextValue(argv, i, "--work-graph"));
      i += 1;
    } else if (arg.startsWith("--work-graph=")) {
      const val = arg.slice("--work-graph=".length);
      if (!val) throw new Error("Missing value for --work-graph");
      opts.workGraph = path.resolve(val);
    } else if (arg === "--linear-project") {
      opts.linearProject = readNextValue(argv, i, "--linear-project").trim();
      i += 1;
    } else if (arg.startsWith("--linear-project=")) {
      const val = arg.slice("--linear-project=".length).trim();
      if (!val) throw new Error("Missing value for --linear-project");
      opts.linearProject = val;
    } else if (arg === "--linear-team") {
      opts.linearTeam = readNextValue(argv, i, "--linear-team").trim();
      i += 1;
    } else if (arg.startsWith("--linear-team=")) {
      const val = arg.slice("--linear-team=".length).trim();
      if (!val) throw new Error("Missing value for --linear-team");
      opts.linearTeam = val;
    } else if (arg === "--poll-ms") {
      opts.pollMs = validatePollMs(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--poll-ms=")) {
      opts.pollMs = validatePollMs(arg.slice("--poll-ms=".length));
    } else if (arg === "--view") {
      const val = readNextValue(argv, i, "--view").toLowerCase();
      if (!ALLOWED_VIEWS.has(val)) {
        throw new Error(
          `Invalid value for --view: ${val} (expected auto, work, or pipeline)`
        );
      }
      opts.view = val;
      i += 1;
    } else if (arg.startsWith("--view=")) {
      const val = arg.slice("--view=".length).toLowerCase();
      if (!ALLOWED_VIEWS.has(val)) {
        throw new Error(
          `Invalid value for --view: ${val} (expected auto, work, or pipeline)`
        );
      }
      opts.view = val;
    } else if (arg === "--json") {
      explicitMode = "json";
    } else if (arg === "--mermaid") {
      explicitMode = "mermaid";
    } else if (arg === "--ascii") {
      explicitMode = "ascii";
    } else if (arg === "--serve") {
      opts.serve = true;
    } else if (arg === "--no-open") {
      opts.noOpen = true;
    } else if (arg === "--port") {
      opts.port = validatePort(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      opts.port = validatePort(arg.slice("--port=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (explicitMode) {
    opts.mode = explicitMode;
  }
  return opts;
}

async function main() {
  assertNode20();

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const hasDirectLinear = Boolean(opts.linearProject || opts.linearTeam);
  const effectiveWorkGraphPath =
    opts.workGraph || findDefaultWorkGraphPath(opts.dir);

  if (opts.serve) {
    let serverModule;
    try {
      serverModule = await import("./server.mjs");
    } catch (err) {
      if (err && err.code === "ERR_MODULE_NOT_FOUND") {
        process.stderr.write(
          "Error: Live server module (server.mjs) is not installed yet.\n"
        );
        process.exit(1);
      }
      throw err;
    }
    await serverModule.startServer({
      workspaceRoot: opts.dir,
      workGraphPath: opts.workGraph,
      linearProject: opts.linearProject,
      linearTeam: opts.linearTeam,
      pollMs: opts.pollMs,
      view: opts.view,
      port: opts.port,
      open: !opts.noOpen,
    });
    return;
  }

  const useWorkView =
    opts.view === "work" ||
    (opts.view === "auto" && (hasDirectLinear || Boolean(effectiveWorkGraphPath)));

  if (useWorkView) {
    let workGraph;
    if (hasDirectLinear) {
      workGraph = await fetchLinearGraph({
        project: opts.linearProject,
        team: opts.linearTeam,
      });
    } else if (effectiveWorkGraphPath) {
      workGraph = loadWorkGraphFile(effectiveWorkGraphPath);
    } else {
      process.stderr.write(
        "Error: --view work requested, but no --work-graph <path>, --linear-project/--linear-team, or docs/factory/work-graph.json was found.\n"
      );
      process.exit(1);
    }

    if (opts.mode === "json") {
      process.stdout.write(JSON.stringify(workGraph, null, 2) + "\n");
    } else if (opts.mode === "mermaid") {
      process.stdout.write(formatWorkMermaid(workGraph) + "\n");
    } else {
      process.stdout.write(formatWorkAscii(workGraph) + "\n");
    }
    return;
  }

  const graph = analyzeWorkspace(opts.dir);
  if (opts.mode === "json") {
    process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
  } else if (opts.mode === "mermaid") {
    process.stdout.write(formatMermaid(graph) + "\n");
  } else {
    process.stdout.write(formatAscii(graph) + "\n");
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
