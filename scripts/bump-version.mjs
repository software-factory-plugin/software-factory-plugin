#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const PLUGIN_MANIFEST_FILES = [
  "plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
];

const MARKETPLACE_FILES = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];

// Strict SemVer 2.0.0: rejects leading zeros in numeric identifiers and allows optional +build metadata.
export const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const README_TAG_RE =
  /(software-factory-plugin\/tree\/v)([^\s)"'`<>]+)/g;

const CHANGELOG_HEADING_RE = /^## \[([^\]]+)\]/m;

function writeFileAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

export function checkVersions(repoRoot = DEFAULT_REPO_ROOT, { checkChangelog = true } = {}) {
  const versions = {};
  const descriptions = {};
  const errors = [];

  for (const rel of PLUGIN_MANIFEST_FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    versions[rel] = data.version ?? null;
    descriptions[rel] = typeof data.description === "string" ? data.description : null;
  }

  for (const rel of MARKETPLACE_FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    const entry = Array.isArray(data.plugins)
      ? data.plugins.find((p) => p?.name === "software-factory")
      : null;
    versions[rel] = entry ? entry.version ?? null : null;
    descriptions[rel] = entry && typeof entry.description === "string" ? entry.description : null;
  }

  const readmePath = path.join(repoRoot, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const readmeTagVersions = [...readme.matchAll(README_TAG_RE)].map((m) => m[2]);
  const uniqueReadmeTags = [...new Set(readmeTagVersions)];
  const readmeVersion =
    readmeTagVersions.length > 0 && uniqueReadmeTags.length === 1
      ? uniqueReadmeTags[0]
      : null;
  if (readmeTagVersions.length === 0) {
    errors.push("README.md has no software-factory-plugin/tree/v<semver> tag links");
  } else if (uniqueReadmeTags.length > 1) {
    errors.push(`README.md has mismatched version tags: ${uniqueReadmeTags.join(", ")}`);
  }

  let changelogVersion = null;
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const m = changelog.match(CHANGELOG_HEADING_RE);
    changelogVersion = m ? m[1].trim() : null;
    if (checkChangelog && !changelogVersion) {
      errors.push("CHANGELOG.md is missing a top-level '## [<semver>]' release heading");
    }
  } else if (checkChangelog) {
    errors.push("Missing CHANGELOG.md");
  }

  const descValues = Object.values(descriptions);
  const uniqueDescriptions = new Set(descValues.filter((d) => typeof d === "string" && d.length > 0));
  const descriptionsMatch =
    uniqueDescriptions.size === 1 &&
    descValues.every((d) => typeof d === "string" && d.length > 0);
  if (!descriptionsMatch) {
    errors.push(
      `Manifest description drift detected (${uniqueDescriptions.size} distinct values across ${descValues.length} manifests)`
    );
  }

  const versionTargets = [...Object.values(versions), readmeVersion];
  if (checkChangelog) {
    versionTargets.push(changelogVersion);
  }
  const uniqueVersions = new Set(versionTargets.filter(Boolean));
  const versionsSynced =
    uniqueVersions.size === 1 &&
    versionTargets.every((v) => typeof v === "string" && SEMVER_RE.test(v));
  if (!versionsSynced) {
    errors.push(`Version mismatch or invalid SemVer across targets`);
  }

  const ok = errors.length === 0 && versionsSynced && descriptionsMatch;
  const syncedVersion = versionsSynced ? [...uniqueVersions][0] : null;

  return {
    ok,
    version: ok ? syncedVersion : null,
    manifests: versions,
    readmeTagVersion: readmeVersion,
    readmeTagVersions,
    changelogVersion,
    descriptionsMatch,
    errors,
  };
}

export function syncVersions(newVersion, repoRoot = DEFAULT_REPO_ROOT, { dryRun = false } = {}) {
  if (typeof newVersion !== "string" || !SEMVER_RE.test(newVersion)) {
    throw new Error(`Invalid SemVer version "${newVersion}" (expected e.g. 0.9.1 or 1.0.0-rc.1)`);
  }

  // Stage and validate every target file in memory BEFORE writing anything to disk.
  const stagedWrites = [];
  const descriptions = new Set();

  for (const rel of PLUGIN_MANIFEST_FILES) {
    const full = path.join(repoRoot, rel);
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Invalid plugin manifest object in ${rel}`);
    }
    if (typeof data.description !== "string" || !data.description.trim()) {
      throw new Error(`Missing description in ${rel}`);
    }
    descriptions.add(data.description);
    data.version = newVersion;
    stagedWrites.push({
      rel,
      full,
      content: JSON.stringify(data, null, 2) + "\n",
    });
  }

  for (const rel of MARKETPLACE_FILES) {
    const full = path.join(repoRoot, rel);
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    if (!Array.isArray(data?.plugins)) {
      throw new Error(`Missing plugins array in ${rel}`);
    }
    let matched = 0;
    for (const p of data.plugins) {
      if (p && p.name === "software-factory") {
        if (typeof p.description !== "string" || !p.description.trim()) {
          throw new Error(`Missing description for software-factory in ${rel}`);
        }
        descriptions.add(p.description);
        p.version = newVersion;
        matched += 1;
      }
    }
    if (matched === 0) {
      throw new Error(`Missing software-factory plugin entry in ${rel}`);
    }
    stagedWrites.push({
      rel,
      full,
      content: JSON.stringify(data, null, 2) + "\n",
    });
  }

  if (descriptions.size !== 1) {
    throw new Error(
      `Manifest description mismatch detected across manifests (${descriptions.size} distinct descriptions); reconcile before bumping`
    );
  }

  const readmePath = path.join(repoRoot, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const tagMatches = [...readme.matchAll(README_TAG_RE)];
  if (tagMatches.length === 0) {
    throw new Error("README.md has no software-factory-plugin/tree/v<semver> tag links to update");
  }
  const updatedReadme = readme.replace(README_TAG_RE, `$1${newVersion}`);
  stagedWrites.push({
    rel: "README.md",
    full: readmePath,
    content: updatedReadme,
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      version: newVersion,
      files: stagedWrites.map((w) => w.rel),
    };
  }

  for (const item of stagedWrites) {
    writeFileAtomic(item.full, item.content);
  }

  const verified = checkVersions(repoRoot, { checkChangelog: false });
  return {
    ...verified,
    changelogNeedsUpdate: verified.changelogVersion !== newVersion,
  };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(
      "Usage:\n  node scripts/bump-version.mjs --check\n  node scripts/bump-version.mjs <semver> [--dry-run]\n"
    );
    process.exit(0);
  }

  if (args.includes("--check")) {
    const res = checkVersions();
    if (res.ok) {
      process.stdout.write(
        `Version sync OK: v${res.version} across all ${Object.keys(res.manifests).length} manifests, README.md, and CHANGELOG.md\n`
      );
      process.exit(0);
    } else {
      process.stderr.write(
        `Version check failed:\n${JSON.stringify(res, null, 2)}\n`
      );
      process.exit(1);
    }
  }

  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length !== 1) {
    process.stderr.write("Error: Expected exactly one <semver> argument\n");
    process.exit(1);
  }

  try {
    const res = syncVersions(positional[0], DEFAULT_REPO_ROOT, { dryRun });
    if (!res.ok) {
      process.stderr.write(`Sync verification failed:\n${JSON.stringify(res, null, 2)}\n`);
      process.exit(1);
    }
    if (dryRun) {
      process.stdout.write(
        `Dry-run OK: would sync ${res.files.length} files to v${res.version} (${res.files.join(", ")})\n`
      );
    } else {
      process.stdout.write(
        `Synced all ${Object.keys(res.manifests).length} manifests and README.md to v${res.version}\n`
      );
      if (res.changelogNeedsUpdate) {
        process.stdout.write(
          `Note: Update CHANGELOG.md top heading to '## [${res.version}]' before running --check.\n`
        );
      }
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}
