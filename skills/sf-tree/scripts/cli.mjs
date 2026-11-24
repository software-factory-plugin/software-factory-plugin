#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "./analyzer.mjs";
import {
  findDefaultWorkGraphPath,
  loadWorkGraphFile,
} from "./work-analyzer.mjs";
import {
  formatAscii,
  formatMermaid,
  formatWorkAscii,
  formatWorkMermaid,
} from "./formatters.mjs";

const ALLOWED_VIEWS = new Set(["auto", "work", "pipeline"]);

function printHelp() {
  const usage = [
    "Usage: node cli.mjs [options]",
    "",
    "Options:",
    "  --dir <path>            Consumer workspace directory (default: cwd)",
    "  --work-graph <path>     Path to canonical work-graph v1 JSON snapshot",
    "  --view <auto|work|pipeline>  Select view mode (default: auto)",
    "  --json                  Output v1 Graph JSON (work or pipeline)",
    "  --mermaid               Output color-coded Mermaid DAG",
    "  --ascii                 Output terminal ASCII tech-tree (default)",
    "  --serve                 Start live local HTTP + SSE tech-tree viewer",
    "  --port <num>            Port for --serve (default: 4173, auto-fallback)",
    "  --no-open               Do not auto-open browser when using --serve",
    "  -h, --help              Show this help message",
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

export function parseArgs(argv) {
  const opts = {
    dir: process.cwd(),
    workGraph: null,
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
    } else if (arg === "--view") {
      const val = readNextValue(argv, i, "--view").toLowerCase();
      if (!ALLOWED_VIEWS.has(val)) {
        throw new Error(`Invalid value for --view: ${val} (expected auto, work, or pipeline)`);
      }
      opts.view = val;
      i += 1;
    } else if (arg.startsWith("--view=")) {
      const val = arg.slice("--view=".length).toLowerCase();
      if (!ALLOWED_VIEWS.has(val)) {
        throw new Error(`Invalid value for --view: ${val} (expected auto, work, or pipeline)`);
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
      const next = argv[i + 1];
      if (!next || !/^\d+$/.test(next)) {
        throw new Error("Invalid numeric value for --port");
      }
      opts.port = Number(next);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      const val = arg.slice("--port=".length);
      if (!val || !/^\d+$/.test(val)) {
        throw new Error("Invalid numeric value for --port");
      }
      opts.port = Number(val);
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
      view: opts.view,
      port: opts.port,
      open: !opts.noOpen,
    });
    return;
  }

  const useWorkView =
    opts.view === "work" ||
    (opts.view === "auto" && Boolean(effectiveWorkGraphPath));

  if (useWorkView) {
    if (!effectiveWorkGraphPath) {
      process.stderr.write(
        "Error: --view work requested, but no --work-graph <path> or docs/factory/work-graph.json was found.\n"
      );
      process.exit(1);
    }
    const workGraph = loadWorkGraphFile(effectiveWorkGraphPath);
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

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
