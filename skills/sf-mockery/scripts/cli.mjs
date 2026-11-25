#!/usr/bin/env node
// Software Factory bundled Mockery CLI (zero dependencies, Node 20+ built-ins only).
// Commands:
//   serve [dir] [--port <n>] [--dev]   Serve a Mockery canvas with SSE hot reload (default command)
//   check [dir] [--json]               Validate flow.json, screens, components, edges, and static lints
//   export [dir] [--out <file>] [--title <name>] [--json]
//                                      Bundle into one self-contained offline preview.html (zero runtime needed)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertNode20, isDirectRun } from '../../../lib/cli-utils.mjs';
import { installGracefulShutdown } from '../../../lib/http-sse.mjs';
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
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string', short: 'p' },
        out: { type: 'string', short: 'o' },
        title: { type: 'string' },
        dev: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  const opts = {
    args: positionals,
    out: values.out,
    title: values.title,
    dev: Boolean(values.dev),
    json: Boolean(values.json),
    help: Boolean(values.help),
  };

  if (values.port !== undefined) {
    const rawPort = values.port.trim();
    if (!/^\d+$/.test(rawPort)) {
      fail('--port needs an integer between 1 and 65535');
    }
    const p = Number(rawPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      fail('--port needs an integer between 1 and 65535');
    }
    opts.port = p;
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
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const resolvedPort = port ?? (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 5180);
  try {
    const { url, name, close } = await serve({
      root,
      port: resolvedPort,
      strictPort: port !== undefined,
      dev,
    });
    installGracefulShutdown(close);
    console.log(`Mockery: ${name} at ${url}`);
    console.log(`Watching ${root}`);
  } catch (err) {
    fail(err.code === 'EADDRINUSE' ? `port ${resolvedPort} is already in use` : err.message);
  }
}

async function main() {
  assertNode20();
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
}

if (isDirectRun(import.meta.url)) {
  await main();
}
