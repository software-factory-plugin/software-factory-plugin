import fs from "node:fs";
import path from "node:path";

const EXPECTED_SKILLS = [
  "sf-vision",
  "sf-market-research",
  "sf-brd",
  "sf-prd",
  "sf-ux",
  "sf-ui",
  "sf-mockery",
  "sf-architecture",
  "sf-specs",
  "sf-review",
  "sf-tree",
  "sf-telemetry",
];

const FORBIDDEN_IDLE_PATHS = [
  "AGENTS.md",
  "GEMINI.md",
  "CLAUDE.md",
  "rules",
  "hooks",
  "mcp_config.json",
  "docs/factory",
];

export function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const raw = match[1];
  const nameMatch = raw.match(/^name:\s*(.+)$/m);
  let description = "";
  const descBlock = raw.match(/^description:\s*>-?\r?\n([\s\S]*?)(?=^\w+:|$)/m);
  if (descBlock) {
    description = descBlock[1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  } else {
    const descInline = raw.match(/^description:\s*(.+)$/m);
    if (descInline) {
      description = descInline[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return {
    raw,
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    description,
  };
}

/**
 * Audit all skills for valid YAML frontmatter, negative trigger boundaries,
 * zero idle token overhead, and manifest consistency.
 */
export function runSkillsAudit(repoRoot) {
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed, detail });

  // 1. Zero idle token overhead files/dirs check
  for (const rel of FORBIDDEN_IDLE_PATHS) {
    const full = path.join(repoRoot, rel);
    const exists = fs.existsSync(full);
    add(
      `idle-overhead:${rel}`,
      !exists,
      exists ? `Forbidden idle-overhead path exists: ${rel}` : `Absent (${rel})`
    );
  }

  // 2. Manifest version & name parity across all 4 harness manifests + 2 marketplace catalogs
  const manifestRelPaths = [
    "plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "gemini-extension.json",
  ];
  const manifests = [];
  for (const rel of manifestRelPaths) {
    const full = path.join(repoRoot, rel);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      add(`manifest-json:${rel}`, true, `Valid JSON (v${parsed.version})`);
    } catch (err) {
      add(`manifest-json:${rel}`, false, `Invalid JSON: ${err.message}`);
    }
    manifests.push({ rel, data: parsed });
  }

  const marketplaceRelPaths = [
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
  ];
  const marketplaceVersions = [];
  const marketplaceEntries = [];
  for (const rel of marketplaceRelPaths) {
    const full = path.join(repoRoot, rel);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      const entry = Array.isArray(parsed.plugins)
        ? parsed.plugins.find((p) => p?.name === "software-factory")
        : null;
      add(
        `marketplace-json:${rel}`,
        Boolean(entry && entry.version),
        entry ? `Valid marketplace entry (v${entry.version})` : "Missing software-factory plugin entry"
      );
      if (entry?.version) marketplaceVersions.push(entry.version);
      marketplaceEntries.push({ rel, data: parsed, entry });
    } catch (err) {
      add(`marketplace-json:${rel}`, false, `Invalid JSON: ${err.message}`);
      marketplaceEntries.push({ rel, data: null, entry: null });
    }
  }

  const versions = new Set(
    [...manifests.map((m) => m.data?.version), ...marketplaceVersions].filter(Boolean)
  );
  const names = new Set(manifests.map((m) => m.data?.name).filter(Boolean));
  const descriptions = new Set(
    [
      ...manifests.map((m) => m.data?.description),
      ...marketplaceEntries.map((m) => m.entry?.description),
    ].filter((d) => typeof d === "string" && d.trim().length > 0)
  );
  add(
    "manifest-version-sync",
    versions.size === 1 &&
      manifests.every((m) => Boolean(m.data?.version)) &&
      marketplaceVersions.length === marketplaceRelPaths.length,
    versions.size === 1
      ? `All 6 plugin/marketplace manifests synced at v${[...versions][0]}`
      : `Version drift detected: ${[...versions].join(", ")}`
  );
  add(
    "manifest-name-sync",
    names.size === 1 && [...names][0] === "software-factory",
    `Plugin name across manifests: ${[...names].join(", ")}`
  );
  add(
    "manifest-description-sync",
    descriptions.size === 1 &&
      manifests.every((m) => typeof m.data?.description === "string" && m.data.description.trim().length > 0) &&
      marketplaceEntries.every((m) => typeof m.entry?.description === "string" && m.entry.description.trim().length > 0),
    descriptions.size === 1
      ? "All 6 manifests share identical description"
      : `Description drift detected across manifests (${descriptions.size} distinct values)`
  );

  // 2b. Packaging assets, cross-manifest path & schema checks, MIT license
  const licenseExists = fs.existsSync(path.join(repoRoot, "LICENSE"));
  add(
    "packaging:license-exists",
    licenseExists,
    licenseExists ? "LICENSE file present" : "Missing root LICENSE file"
  );

  const checkRelPath = (id, relPath, label) => {
    const ok =
      typeof relPath === "string" &&
      relPath.length > 0 &&
      fs.existsSync(path.resolve(repoRoot, relPath));
    add(
      id,
      ok,
      ok ? `${label} "${relPath}" present` : `Missing or invalid ${label} (${String(relPath)})`
    );
  };

  const antigravity = manifests.find((m) => m.rel === "plugin.json")?.data;
  const claude = manifests.find((m) => m.rel === ".claude-plugin/plugin.json")?.data;
  const codex = manifests.find((m) => m.rel === ".codex-plugin/plugin.json")?.data;
  const gemini = manifests.find((m) => m.rel === "gemini-extension.json")?.data;
  const claudeMkt = marketplaceEntries.find((m) => m.rel === ".claude-plugin/marketplace.json")?.entry;
  const codexMkt = marketplaceEntries.find((m) => m.rel === ".agents/plugins/marketplace.json")?.entry;

  checkRelPath("packaging:logo-exists", antigravity?.logo, "plugin.json logo");
  checkRelPath("packaging:codex-skills-path", codex?.skills, ".codex-plugin/plugin.json skills");
  checkRelPath("packaging:codex-logo-exists", codex?.interface?.logo, ".codex-plugin/plugin.json interface.logo");
  checkRelPath(
    "packaging:codex-composer-icon-exists",
    codex?.interface?.composerIcon,
    ".codex-plugin/plugin.json interface.composerIcon"
  );
  checkRelPath("packaging:claude-marketplace-source", claudeMkt?.source, ".claude-plugin/marketplace.json source");
  checkRelPath(
    "packaging:codex-marketplace-source",
    codexMkt?.source?.path,
    ".agents/plugins/marketplace.json source.path"
  );

  const codexAuthPolicy = codexMkt?.policy?.authentication;
  add(
    "packaging:codex-auth-free-policy",
    codexAuthPolicy !== "ON_INSTALL",
    codexAuthPolicy !== "ON_INSTALL"
      ? `Auth-free marketplace policy (${codexAuthPolicy ?? "none"})`
      : 'Codex marketplace sets policy.authentication="ON_INSTALL" on an auth-free plugin'
  );

  const schemaFieldsOk = Boolean(
    antigravity?.displayName &&
      Array.isArray(antigravity?.suggestedPrompts) &&
      claude?.license === "MIT" &&
      Array.isArray(claude?.keywords) &&
      codex?.interface?.displayName &&
      codex?.interface?.shortDescription &&
      gemini?.name === "software-factory"
  );
  add(
    "packaging:manifest-schemas",
    schemaFieldsOk,
    schemaFieldsOk
      ? "All 4 harness manifests satisfy required schema fields"
      : "One or more harness manifests are missing required fields"
  );

  // 3. Skill directory & frontmatter checks
  const skillsDir = path.join(repoRoot, "skills");
  const actualDirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const expectedSorted = [...EXPECTED_SKILLS].sort();
  const unexpectedDirs = actualDirs.filter((d) => !EXPECTED_SKILLS.includes(d));
  add(
    "skills-exact-parity",
    unexpectedDirs.length === 0 && actualDirs.length === expectedSorted.length,
    unexpectedDirs.length === 0 && actualDirs.length === expectedSorted.length
      ? `Exact parity: ${actualDirs.length} expected skill directories`
      : `Directory mismatch (unexpected: ${unexpectedDirs.join(", ") || "none"})`
  );

  for (const expected of EXPECTED_SKILLS) {
    add(
      `skill-present:${expected}`,
      actualDirs.includes(expected),
      actualDirs.includes(expected) ? "Present" : `Missing skills/${expected}`
    );
  }

  for (const dirName of actualDirs) {
    const skillFile = path.join(skillsDir, dirName, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      add(`skill-file:${dirName}`, false, "Missing SKILL.md");
      continue;
    }
    const content = fs.readFileSync(skillFile, "utf8");
    const fm = parseFrontmatter(content);
    if (!fm) {
      add(`skill-frontmatter:${dirName}`, false, "Missing YAML frontmatter");
      continue;
    }
    add(
      `skill-name-match:${dirName}`,
      fm.name === dirName,
      fm.name === dirName
        ? `name="${fm.name}"`
        : `Frontmatter name "${fm.name}" !== folder "${dirName}"`
    );

    const words = fm.description.split(/\s+/).filter(Boolean).length;
    add(
      `skill-desc-concise:${dirName}`,
      words >= 15 && words <= 85,
      `${words} words (budget: 15..85)`
    );

    const hasNegativeBoundary = /Do NOT\b/i.test(fm.description);
    add(
      `skill-negative-trigger:${dirName}`,
      hasNegativeBoundary,
      hasNegativeBoundary
        ? "Contains explicit Do NOT boundary"
        : "Missing 'Do NOT' negative trigger boundary in frontmatter description"
    );
  }

  return {
    suite: "skills",
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    total: checks.length,
    checks,
  };
}
