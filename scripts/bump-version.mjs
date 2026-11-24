#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANIFEST_FILES = [
  "plugin.json",
  ".claude-plugin/plugin.json",
  "gemini-extension.json",
];
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const README_TAG_RE = /(software-factory-plugin\/tree\/v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

export function checkVersions(repoRoot = DEFAULT_REPO_ROOT) {
  const versions = {};
  for (const rel of MANIFEST_FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    versions[rel] = data.version;
  }

  const readmePath = path.join(repoRoot, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const tagMatch = readme.match(/software-factory-plugin\/tree\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  const readmeVersion = tagMatch ? tagMatch[1] : null;

  const unique = new Set([...Object.values(versions), readmeVersion].filter(Boolean));
  const ok =
    unique.size === 1 &&
    Object.values(versions).every((v) => typeof v === "string" && SEMVER_RE.test(v)) &&
    readmeVersion !== null;

  return {
    ok,
    version: ok ? [...unique][0] : null,
    manifests: versions,
    readmeTagVersion: readmeVersion,
  };
}

export function syncVersions(newVersion, repoRoot = DEFAULT_REPO_ROOT) {
  if (!SEMVER_RE.test(newVersion)) {
    throw new Error(`Invalid SemVer version "${newVersion}" (expected e.g. 0.7.0)`);
  }

  for (const rel of MANIFEST_FILES) {
    const full = path.join(repoRoot, rel);
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    data.version = newVersion;
    fs.writeFileSync(full, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  const readmePath = path.join(repoRoot, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const updatedReadme = readme.replace(README_TAG_RE, `$1${newVersion}`);
  fs.writeFileSync(readmePath, updatedReadme, "utf8");

  return checkVersions(repoRoot);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(
      "Usage:\n  node scripts/bump-version.mjs --check\n  node scripts/bump-version.mjs <semver>\n"
    );
    process.exit(0);
  }

  if (args[0] === "--check") {
    const res = checkVersions();
    if (res.ok) {
      process.stdout.write(`Version sync OK: v${res.version} across all 3 manifests and README.md\n`);
      process.exit(0);
    } else {
      process.stderr.write(
        `Version mismatch detected:\n${JSON.stringify(res, null, 2)}\n`
      );
      process.exit(1);
    }
  }

  try {
    const res = syncVersions(args[0]);
    if (!res.ok) {
      process.stderr.write(`Sync verification failed:\n${JSON.stringify(res, null, 2)}\n`);
      process.exit(1);
    }
    process.stdout.write(`Synced all 3 manifests and README.md to v${res.version}\n`);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}
