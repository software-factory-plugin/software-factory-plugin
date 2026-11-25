// Monorepo-aware sync & async memoized git timestamp resolution for sf-tree.
// Computes a single canonical scalar freshness timestamp per file (Node 20+ built-ins only).
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Parse `git status --porcelain --untracked-files=all` output into workspace-relative POSIX paths,
 * stripping `repoPrefix` (from `git rev-parse --show-prefix`) for workspaces nested inside a monorepo.
 */
export function parsePorcelainDirtyPaths(stdout, repoPrefix = "") {
  const dirty = new Set();
  const normalizedPrefix = normalizePrefix(repoPrefix);
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    let rel = line.slice(3).trim();
    if (rel.includes(" -> ")) {
      rel = rel.split(" -> ").pop().trim();
    }
    if (rel.startsWith('"') && rel.endsWith('"')) {
      rel = rel.slice(1, -1);
    }
    rel = rel.replaceAll("\\", "/");
    if (normalizedPrefix && rel.startsWith(normalizedPrefix)) {
      rel = rel.slice(normalizedPrefix.length);
    }
    if (rel) {
      dirty.add(rel);
    }
  }
  return dirty;
}

function normalizePrefix(prefix) {
  const clean = String(prefix || "").trim().replaceAll("\\", "/");
  if (!clean) return "";
  return clean.endsWith("/") ? clean : `${clean}/`;
}

/**
 * Synchronous per-run memoized git timestamp resolver (for CLI & evals).
 */
export function createSyncGitTimeResolver(workspaceRoot, factoryDir = "docs/factory") {
  let isGitRepo = null;
  let repoPrefix = null;
  let dirtyFiles = null;
  const commitTimeCache = new Map();

  function ensureGitChecked() {
    if (isGitRepo !== null) return isGitRepo;
    try {
      const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      isGitRepo = out === "true";
    } catch {
      isGitRepo = false;
    }
    return isGitRepo;
  }

  function getRepoPrefix() {
    if (repoPrefix !== null) return repoPrefix;
    if (!ensureGitChecked()) {
      repoPrefix = "";
      return repoPrefix;
    }
    try {
      const out = execFileSync("git", ["rev-parse", "--show-prefix"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      repoPrefix = normalizePrefix(out);
    } catch {
      repoPrefix = "";
    }
    return repoPrefix;
  }

  function getDirtyFiles() {
    if (dirtyFiles !== null) return dirtyFiles;
    dirtyFiles = new Set();
    if (!ensureGitChecked()) return dirtyFiles;
    try {
      const prefix = getRepoPrefix();
      const out = execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=all", "--", factoryDir],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      dirtyFiles = parsePorcelainDirtyPaths(out, prefix);
    } catch {
      // Ignore git status failures and treat as no dirty info.
    }
    return dirtyFiles;
  }

  function getGitTimeMs(relPath) {
    const normalized = String(relPath || "").replaceAll("\\", "/");
    if (commitTimeCache.has(normalized)) {
      return commitTimeCache.get(normalized);
    }
    if (!ensureGitChecked()) {
      commitTimeCache.set(normalized, null);
      return null;
    }
    if (getDirtyFiles().has(normalized)) {
      commitTimeCache.set(normalized, null);
      return null;
    }
    try {
      const out = execFileSync(
        "git",
        ["log", "-1", "--format=%ct", "--", normalized],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim();
      if (!out || !/^\d+$/.test(out)) {
        commitTimeCache.set(normalized, null);
        return null;
      }
      const ms = Number(out) * 1000;
      commitTimeCache.set(normalized, ms);
      return ms;
    } catch {
      commitTimeCache.set(normalized, null);
      return null;
    }
  }

  function resolveCanonicalFreshness(relPath, mtimeMs) {
    const gitMs = getGitTimeMs(relPath);
    if (typeof gitMs === "number" && Number.isFinite(gitMs)) {
      return { effective_time_ms: gitMs, time_source: "git" };
    }
    return { effective_time_ms: mtimeMs, time_source: "mtime" };
  }

  return {
    getGitTimeMs,
    getDirtyFiles,
    getRepoPrefix,
    resolveCanonicalFreshness,
  };
}

/**
 * Asynchronous per-run memoized git timestamp resolver (non-blocking for HTTP/SSE server).
 */
export function createAsyncGitTimeResolver(workspaceRoot, factoryDir = "docs/factory") {
  let isGitRepoPromise = null;
  let repoPrefixPromise = null;
  let dirtyFilesPromise = null;
  const commitTimePromises = new Map();

  function ensureGitChecked() {
    if (!isGitRepoPromise) {
      isGitRepoPromise = execFileAsync(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        { cwd: workspaceRoot, encoding: "utf8" }
      )
        .then(({ stdout }) => String(stdout || "").trim() === "true")
        .catch(() => false);
    }
    return isGitRepoPromise;
  }

  function getRepoPrefix() {
    if (!repoPrefixPromise) {
      repoPrefixPromise = ensureGitChecked().then(async (isRepo) => {
        if (!isRepo) return "";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["rev-parse", "--show-prefix"],
            { cwd: workspaceRoot, encoding: "utf8" }
          );
          return normalizePrefix(stdout);
        } catch {
          return "";
        }
      });
    }
    return repoPrefixPromise;
  }

  function getDirtyFiles() {
    if (!dirtyFilesPromise) {
      dirtyFilesPromise = ensureGitChecked().then(async (isRepo) => {
        if (!isRepo) return new Set();
        try {
          const [prefix, res] = await Promise.all([
            getRepoPrefix(),
            execFileAsync(
              "git",
              ["status", "--porcelain", "--untracked-files=all", "--", factoryDir],
              { cwd: workspaceRoot, encoding: "utf8" }
            ),
          ]);
          return parsePorcelainDirtyPaths(res.stdout, prefix);
        } catch {
          return new Set();
        }
      });
    }
    return dirtyFilesPromise;
  }

  function getGitTimeMs(relPath) {
    const normalized = String(relPath || "").replaceAll("\\", "/");
    if (commitTimePromises.has(normalized)) {
      return commitTimePromises.get(normalized);
    }
    const p = (async () => {
      if (!(await ensureGitChecked())) return null;
      const dirty = await getDirtyFiles();
      if (dirty.has(normalized)) return null;
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["log", "-1", "--format=%ct", "--", normalized],
          { cwd: workspaceRoot, encoding: "utf8" }
        );
        const out = String(stdout || "").trim();
        if (!out || !/^\d+$/.test(out)) return null;
        return Number(out) * 1000;
      } catch {
        return null;
      }
    })();
    commitTimePromises.set(normalized, p);
    return p;
  }

  async function resolveCanonicalFreshness(relPath, mtimeMs) {
    const gitMs = await getGitTimeMs(relPath);
    if (typeof gitMs === "number" && Number.isFinite(gitMs)) {
      return { effective_time_ms: gitMs, time_source: "git" };
    }
    return { effective_time_ms: mtimeMs, time_source: "mtime" };
  }

  return {
    getGitTimeMs,
    getDirtyFiles,
    getRepoPrefix,
    resolveCanonicalFreshness,
  };
}
