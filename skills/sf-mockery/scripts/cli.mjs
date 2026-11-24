#!/usr/bin/env node
// Software Factory bundled Mockery CLI (zero dependencies, Node 20+ built-ins only).
// Commands:
//   serve [dir] [--port <n>] [--dev]   Serve a Mockery canvas with SSE hot reload (default command)
//   check [dir] [--json]               Validate flow.json, screens, components, edges, and static lints
//   export [dir] [--out <file>] [--title <name>] [--json]
//                                      Bundle into one self-contained offline preview.html (zero runtime needed)
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './server.mjs';
import { checkProject } from './check.mjs';
import { exportProject } from './export.mjs';

const FACTORY_DIR = path.join('docs', 'factory', 'mockups');
const DEFAULT_DIR = 'mockups';
const USAGE = `Usage:
  node skills/sf-mockery/scripts/cli.mjs serve [dir] [--port <n>] [--dev]
      Serve a Mockery canvas with live SSE hot reload on 127.0.0.1 (default port 5180).
      Auto-detects ./${FACTORY_DIR}, ./${DEFAULT_DIR}, or the current directory when dir is omitted.

  node skills/sf-mockery/scripts/cli.mjs check [dir] [--json]
      Validate flow.json, screens, <x-include> components, edges, and static screen lint rules.

  node skills/sf-mockery/scripts/cli.mjs export [dir] [--out <file>] [--title <name>] [--json]
      Compile the canvas into one standalone offline HTML file (default: <dir>/preview.html)
      that opens directly in any browser with no server or Node.js required.`;

function fail(message) {
  console.error(`sf-mockery: ${message}`);
  process.exit(1);
}

function parse(argv) {
  const opts = { args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = argv[++i];
    else if (a.startsWith('--port=')) opts.port = a.slice(7);
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a === '--title') opts.title = argv[++i];
    else if (a.startsWith('--title=')) opts.title = a.slice(8);
    else if (a === '--dev') opts.dev = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) fail(`unknown option ${a}\n\n${USAGE}`);
    else opts.args.push(a);
  }
  if (opts.port !== undefined) {
    opts.port = Number(opts.port);
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      fail('--port needs an integer between 1 and 65535');
    }
  }
  return opts;
}

export function findProject(dir) {
  if (dir) return path.resolve(dir);
  for (const candidate of [FACTORY_DIR, DEFAULT_DIR]) {
    const abs = path.resolve(candidate);
    if (fs.existsSync(path.join(abs, 'flow.json'))) return abs;
  }
  return process.cwd();
}

function runCheck(dir, { json = false } = {}) {
  const root = findProject(dir);
  const report = checkProject(root);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { sections, nodes, edges, components } = report.summary;
    console.log(`Checking ${root}`);
    console.log(`  sections ${sections} · nodes ${nodes} · edges ${edges} · components ${components}`);
    for (const err of report.errors) console.error(`  ✗ [${err.code}] ${err.message}`);
    for (const warn of report.warnings) console.warn(`  ! [${warn.code}] ${warn.message}`);
    console.log(report.ok ? '✔ Mockery check passed' : `✗ Mockery check failed (${report.errors.length} error(s))`);
  }
  process.exit(report.ok ? 0 : 1);
}

function runExport(dir, { out, title, json = false } = {}) {
  const root = findProject(dir);
  let result;
  try {
    result = exportProject(root, { outFile: out, title });
  } catch (err) {
    fail(err.message);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const kb = (result.bytes / 1024).toFixed(1);
    const { nodes, edges, components, assets } = result.summary;
    console.log(`Exported standalone preview: ${result.outFile} (${kb} KB)`);
    console.log(`  nodes ${nodes} · edges ${edges} · components ${components} · assets ${assets}`);
    console.log('Open directly in any browser (no server or Node.js required).');
  }
}

async function runServe(dir, { port, dev } = {}) {
  const root = findProject(dir);
  if (!fs.existsSync(path.join(root, 'flow.json'))) {
    fail(`no flow.json in ${root}`);
  }
  try {
    const { url, name } = await serve({
      root,
      port: port ?? (Number(process.env.PORT) || 5180),
      strictPort: port !== undefined,
      dev,
    });
    console.log(`Mockery: ${name} at ${url}`);
    console.log(`Watching ${root}`);
  } catch (err) {
    fail(err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message);
  }
}

const opts = parse(process.argv.slice(2));
const cmd = opts.args[0];

if (opts.help) {
  console.log(USAGE);
} else if (cmd === 'check') {
  runCheck(opts.args[1], opts);
} else if (cmd === 'export') {
  runExport(opts.args[1], opts);
} else if (cmd === 'serve') {
  await runServe(opts.args[1], opts);
} else {
  await runServe(cmd, opts);
}
