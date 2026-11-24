#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "./analyzer.mjs";
import { formatAscii, formatMermaid } from "./formatters.mjs";

function printHelp() {
  const usage = [
    "Usage: node cli.mjs [options]",
    "",
    "Options:",
    "  --dir <path>    Consumer workspace directory (default: cwd)",
    "  --json          Output v1 Graph JSON",
    "  --mermaid       Output color-coded Mermaid DAG",
    "  --ascii         Output terminal ASCII tech-tree (default)",
    "  --serve         Start live local HTTP + SSE tech-tree viewer",
    "  --port <num>    Port for --serve (default: 4173, auto-fallback)",
    "  --no-open       Do not auto-open browser when using --serve",
    "  -h, --help      Show this help message",
  ];
  process.stdout.write(usage.join("\n") + "\n");
}

export function parseArgs(argv) {
  const opts = {
    dir: process.cwd(),
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
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --dir");
      }
      opts.dir = path.resolve(next);
      i += 1;
    } else if (arg.startsWith("--dir=")) {
      const val = arg.slice("--dir=".length);
      if (!val) throw new Error("Missing value for --dir");
      opts.dir = path.resolve(val);
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
      port: opts.port,
      open: !opts.noOpen,
    });
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
