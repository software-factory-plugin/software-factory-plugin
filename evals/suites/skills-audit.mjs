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

  // 2. Manifest version & name parity across all 3 manifests
  const manifestRelPaths = [
    "plugin.json",
    ".claude-plugin/plugin.json",
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

  const versions = new Set(manifests.map((m) => m.data?.version).filter(Boolean));
  const names = new Set(manifests.map((m) => m.data?.name).filter(Boolean));
  add(
    "manifest-version-sync",
    versions.size === 1 && manifests.every((m) => Boolean(m.data?.version)),
    versions.size === 1
      ? `All 3 manifests synced at v${[...versions][0]}`
      : `Version drift detected: ${[...versions].join(", ")}`
  );
  add(
    "manifest-name-sync",
    names.size === 1 && [...names][0] === "software-factory",
    `Plugin name across manifests: ${[...names].join(", ")}`
  );

  // 2b. Packaging assets & MIT license checks
  const licenseExists = fs.existsSync(path.join(repoRoot, "LICENSE"));
  add(
    "packaging:license-exists",
    licenseExists,
    licenseExists ? "LICENSE file present" : "Missing root LICENSE file"
  );
  const logoRel = manifests[0]?.data?.logo;
  const logoExists =
    typeof logoRel === "string" &&
    logoRel.length > 0 &&
    fs.existsSync(path.join(repoRoot, logoRel));
  add(
    "packaging:logo-exists",
    logoExists,
    logoExists
      ? `plugin.json logo "${logoRel}" present`
      : `Missing or unreferenced logo asset (${String(logoRel)})`
  );

  // 3. Skill directory & frontmatter checks
  const skillsDir = path.join(repoRoot, "skills");
  const actualDirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

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
      words >= 15 && words <= 180,
      `${words} words (budget: 15..180)`
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
