import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkVersions, syncVersions, SEMVER_RE } from "../scripts/bump-version.mjs";
import {
  parseArgs as parseEvalArgs,
  formatMarkdown as formatEvalMarkdown,
} from "../evals/run.mjs";
import { runTokenEfficiencyEval } from "../evals/suites/token-efficiency.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const VERSION_FILES = [
  "plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "README.md",
  "CHANGELOG.md",
];

function makeTempDir(prefix = "sf-bump-eval-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyVersionFiles(dstRoot) {
  for (const rel of VERSION_FILES) {
    const dst = path.join(dstRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
  }
}

function collectJsFiles(rootDir, out = []) {
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) {
      out.push(full);
    }
  }
  return out;
}

test("bump-version: checkVersions() validates manifests, all README tags, CHANGELOG heading & description parity", () => {
  // 1. Real repository check passes
  const live = checkVersions(REPO_ROOT);
  assert.equal(live.ok, true, `Expected synced versions across repo, got ${JSON.stringify(live)}`);
  assert.match(live.version, SEMVER_RE);
  assert.equal(Object.keys(live.manifests).length, 6);
  assert.equal(live.readmeTagVersion, live.version);
  assert.equal(live.changelogVersion, live.version);
  assert.equal(live.descriptionsMatch, true);
  assert.deepEqual(live.errors, []);

  const cliOut = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "bump-version.mjs"), "--check"],
    { encoding: "utf8" }
  );
  assert.match(cliOut, /Version sync OK/);

  // 2. Strict SemVer 2.0.0 validation: rejects leading zeros, accepts +build
  assert.equal(SEMVER_RE.test("01.02.03"), false);
  assert.equal(SEMVER_RE.test("1.02.3"), false);
  assert.equal(SEMVER_RE.test("1.2.3+build.42"), true);
  assert.equal(SEMVER_RE.test("1.2.3-rc.1+sha.abc"), true);

  // 3. Temp copy negative checks: manifest drift, multi-tag README drift, CHANGELOG drift, description drift
  const tmp = makeTempDir("sf-ver-");
  try {
    copyVersionFiles(tmp);

    // Multi-tag README drift (second tag mismatches first tag)
    const readmePath = path.join(tmp, "README.md");
    const origReadme = fs.readFileSync(readmePath, "utf8");
    fs.writeFileSync(
      readmePath,
      `${origReadme}\nhttps://github.com/software-factory-plugin/software-factory-plugin/tree/v0.1.0\n`,
      "utf8"
    );
    const readmeDrift = checkVersions(tmp);
    assert.equal(readmeDrift.ok, false);
    assert.ok(readmeDrift.errors.some((e) => /README\.md has mismatched version tags/.test(e)));
    fs.writeFileSync(readmePath, origReadme, "utf8");

    // CHANGELOG top heading drift
    const changelogPath = path.join(tmp, "CHANGELOG.md");
    const origChangelog = fs.readFileSync(changelogPath, "utf8");
    fs.writeFileSync(changelogPath, "# Changelog\n\n## [0.1.0] — 2026-01-01\n", "utf8");
    const clDrift = checkVersions(tmp);
    assert.equal(clDrift.ok, false);
    assert.equal(clDrift.changelogVersion, "0.1.0");
    fs.writeFileSync(changelogPath, origChangelog, "utf8");

    // Manifest description drift (also blocks syncVersions before writing any file!)
    const geminiPath = path.join(tmp, "gemini-extension.json");
    const origGemini = fs.readFileSync(geminiPath, "utf8");
    const geminiJson = JSON.parse(origGemini);
    geminiJson.description = "Drifted description";
    fs.writeFileSync(geminiPath, JSON.stringify(geminiJson, null, 2) + "\n", "utf8");

    const descDrift = checkVersions(tmp);
    assert.equal(descDrift.ok, false);
    assert.equal(descDrift.descriptionsMatch, false);

    // Atomic in-memory pre-validation: syncVersions fails without modifying plugin.json
    const beforePlugin = fs.readFileSync(path.join(tmp, "plugin.json"), "utf8");
    assert.throws(() => syncVersions("9.8.7", tmp), /description mismatch/i);
    assert.equal(fs.readFileSync(path.join(tmp, "plugin.json"), "utf8"), beforePlugin);

    // Restore description and test invalid SemVer, dry-run, and real atomic sync
    fs.writeFileSync(geminiPath, origGemini, "utf8");
    for (const bad of ["v1.2.3", "1.2", "01.02.03", "not-semver", ""]) {
      assert.throws(() => syncVersions(bad, tmp), /Invalid SemVer/);
    }

    const dry = syncVersions("9.8.7-rc.1+build.2", tmp, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.files.length, 7);
    assert.equal(fs.readFileSync(path.join(tmp, "plugin.json"), "utf8"), beforePlugin);

    const synced = syncVersions("9.8.7-rc.1+build.2", tmp);
    assert.equal(synced.ok, true);
    assert.equal(synced.version, "9.8.7-rc.1+build.2");
    assert.equal(synced.readmeTagVersion, "9.8.7-rc.1+build.2");
    assert.equal(synced.changelogNeedsUpdate, true);
    for (const v of Object.values(synced.manifests)) {
      assert.equal(v, "9.8.7-rc.1+build.2");
    }
    const updatedReadme = fs.readFileSync(readmePath, "utf8");
    assert.ok(updatedReadme.includes("software-factory-plugin/tree/v9.8.7-rc.1+build.2"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("evals/run.mjs: --json passes, --markdown renders failing check details, and token-efficiency fails on missing frontmatter", () => {
  assert.deepEqual(parseEvalArgs(["--suite", "skills", "--json"]), {
    suite: "skills",
    mode: "json",
    help: false,
  });
  assert.throws(() => parseEvalArgs(["--suite", "bogus"]), /Invalid --suite/);
  assert.throws(() => parseEvalArgs(["--nope"]), /Unknown option/);

  // Verify formatMarkdown includes failing check details
  const mdFail = formatEvalMarkdown({
    ok: false,
    summary: { passed: 1, failed: 1, total: 2 },
    suites: [
      {
        suite: "skills",
        passed: 1,
        failed: 1,
        total: 2,
        checks: [
          { id: "ok-check", passed: true, detail: "fine" },
          { id: "broken-check", passed: false, detail: "Missing YAML frontmatter" },
        ],
      },
    ],
  });
  assert.match(mdFail, /## Failures/);
  assert.match(mdFail, /\[skills\] broken-check/);
  assert.match(mdFail, /Missing YAML frontmatter/);

  // Verify token-efficiency fails explicitly on missing/corrupt frontmatter instead of 0-token PASS
  const tmp = makeTempDir("sf-tok-");
  try {
    const skillDir = path.join(tmp, "skills", "sf-broken");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# No frontmatter at all\n", "utf8");
    const tokRes = runTokenEfficiencyEval(tmp);
    assert.ok(tokRes.failed >= 2, `Expected frontmatter + total failure, got ${JSON.stringify(tokRes)}`);
    assert.ok(tokRes.checks.some((c) => c.id === "frontmatter-valid:sf-broken" && !c.passed));
    assert.ok(tokRes.checks.some((c) => c.id === "idle-router-budget:total" && !c.passed));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Real repo --json check
  const raw = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "evals", "run.mjs"), "--json"],
    { encoding: "utf8" }
  );
  const report = JSON.parse(raw);
  assert.equal(report.schema_version, "1.0");
  assert.equal(report.report_type, "software-factory-evals");
  assert.equal(report.ok, true);
  assert.equal(report.summary.failed, 0);
  assert.ok(report.summary.passed > 0);
  assert.equal(report.summary.passed, report.summary.total);

  const suiteNames = report.suites.map((s) => s.suite).sort();
  assert.deepEqual(suiteNames, ["guards", "schemas", "skills", "tokens"]);
  for (const s of report.suites) {
    assert.equal(s.failed, 0, `Eval suite "${s.suite}" had failures`);
  }
});

test("repo-wide syntax check: node --check succeeds on every .mjs and .js file under lib/, skills/, scripts/, evals/, and tests/", () => {
  const dirs = ["lib", "skills", "scripts", "evals", "tests"];
  const files = dirs.flatMap((d) => collectJsFiles(path.join(REPO_ROOT, d))).sort();
  assert.ok(files.length >= 25, `Expected >= 25 JS/MJS files across repo, found ${files.length}`);

  for (const file of files) {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  }
});
