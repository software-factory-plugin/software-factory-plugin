// Shared symlink-safe path containment and resilient file-watcher utilities (Node 20+ built-ins only).
import fs from "node:fs";
import path from "node:path";
import { toPosixPath } from "./cli-utils.mjs";

/**
 * Lexical containment check: returns true if targetPath is equal to or inside baseDir.
 */
export function isPathInside(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + path.sep)
  );
}

/**
 * Reject raw URL/path strings carrying traversal encodings, backslashes, or NUL bytes.
 */
export function hasUnsafeRawPath(rawPath) {
  const lower = String(rawPath ?? "").toLowerCase();
  return (
    lower.includes("..") ||
    lower.includes("%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("\\") ||
    lower.includes("%00") ||
    lower.includes("\0")
  );
}

/**
 * Resolve `relPath` strictly inside `baseDir`, verifying via `lstatSync` and `realpathSync`
 * that no intermediate directory or target file is a symlink escaping `baseDir`.
 *
 * Returns:
 * - `{ ok: true, clean, absPath, realPath, stat }` on success
 * - `{ ok: false, reason: "invalid_path" | "not_found" | "symlink_not_allowed" | "path_escape" | "not_a_file" }`
 */
export function resolveContainedPath(
  baseDir,
  relPath,
  { allowBase = false, allowSymlinks = false, requireFile = false } = {}
) {
  if (typeof relPath !== "string") {
    return { ok: false, reason: "invalid_path" };
  }
  if (relPath.includes("\0")) {
    return { ok: false, reason: "invalid_path" };
  }

  const absBase = path.resolve(baseDir);
  let realBase;
  try {
    realBase = fs.realpathSync(absBase);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  const clean = relPath.replace(/^\/+/, "");
  const absTarget = path.resolve(absBase, clean);
  if (!isPathInside(absBase, absTarget)) {
    return { ok: false, reason: "path_escape" };
  }
  if (!allowBase && absTarget === absBase) {
    return { ok: false, reason: "invalid_path" };
  }

  // Walk every path segment below absBase to reject symlinks even inside nested directories.
  const relFromBase = path.relative(absBase, absTarget);
  if (relFromBase && (relFromBase.startsWith("..") || path.isAbsolute(relFromBase))) {
    return { ok: false, reason: "path_escape" };
  }

  let cur = absBase;
  let finalLstat = null;
  const segments = relFromBase ? relFromBase.split(path.sep).filter(Boolean) : [];
  for (const seg of segments) {
    cur = path.join(cur, seg);
    let lst;
    try {
      lst = fs.lstatSync(cur);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return { ok: false, reason: "not_found" };
      }
      return { ok: false, reason: "invalid_path" };
    }
    if (!allowSymlinks && lst.isSymbolicLink()) {
      return { ok: false, reason: "symlink_not_allowed" };
    }
    finalLstat = lst;
  }

  if (segments.length === 0) {
    try {
      finalLstat = fs.lstatSync(absBase);
    } catch {
      return { ok: false, reason: "not_found" };
    }
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(absTarget);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  if (!isPathInside(realBase, realTarget)) {
    return { ok: false, reason: "path_escape" };
  }
  if (!allowBase && realTarget === realBase) {
    return { ok: false, reason: "invalid_path" };
  }

  let stat = finalLstat;
  if (allowSymlinks && finalLstat && finalLstat.isSymbolicLink()) {
    try {
      stat = fs.statSync(realTarget);
    } catch {
      return { ok: false, reason: "not_found" };
    }
  }

  if (requireFile && (!stat || !stat.isFile())) {
    return { ok: false, reason: "not_a_file" };
  }

  return {
    ok: true,
    clean: toPosixPath(relFromBase),
    absPath: absTarget,
    realPath: realTarget,
    stat,
  };
}

/**
 * Safely stat a regular file inside `baseDir`, rejecting symlinks and escapes.
 * Returns the fs.Stats object if the file exists and is safely contained, else null.
 */
export function safeStatContainedFile(baseDir, relOrAbsPath) {
  const absBase = path.resolve(baseDir);
  const absTarget = path.isAbsolute(relOrAbsPath)
    ? path.resolve(relOrAbsPath)
    : path.resolve(absBase, relOrAbsPath);
  if (!isPathInside(absBase, absTarget) || absTarget === absBase) {
    return null;
  }
  const rel = path.relative(absBase, absTarget);
  const res = resolveContainedPath(absBase, rel, {
    allowBase: false,
    allowSymlinks: false,
    requireFile: true,
  });
  return res.ok ? res.stat : null;
}

/**
 * Safely read a regular file strictly contained inside `baseDir` (rejecting symlinks & escapes).
 */
export function readContainedFile(baseDir, relPath, { encoding = "utf8" } = {}) {
  const res = resolveContainedPath(baseDir, relPath, {
    allowBase: false,
    allowSymlinks: false,
    requireFile: true,
  });
  if (!res.ok) return res;
  try {
    const content = fs.readFileSync(res.realPath, encoding);
    return { ...res, content };
  } catch (err) {
    return {
      ok: false,
      reason: err && err.code === "ENOENT" ? "not_found" : "read_error",
      error: err,
    };
  }
}

/**
 * Create a resilient `fs.watch` wrapper with per-path debouncing, `.on("error")` protection,
 * and complete timer cleanup on `close()`.
 */
export function createDebouncedWatcher(
  dir,
  {
    recursive = false,
    debounceMs = 40,
    filter = () => true,
    onChange,
    onError,
  } = {}
) {
  const pending = new Map();
  let closed = false;
  let watcher = null;

  try {
    watcher = fs.watch(dir, { recursive }, (_event, rawName) => {
      if (closed) return;
      const rel = rawName ? toPosixPath(String(rawName)) : "";
      if (!filter(rel)) return;
      const key = rel || "*";
      if (pending.has(key)) {
        clearTimeout(pending.get(key));
      }
      const timer = setTimeout(() => {
        pending.delete(key);
        if (!closed && typeof onChange === "function") {
          onChange(rel);
        }
      }, debounceMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      pending.set(key, timer);
    });

    watcher.on("error", (err) => {
      if (typeof onError === "function") {
        onError(err);
      }
    });
  } catch (err) {
    if (typeof onError === "function") {
      onError(err);
    }
    return null;
  }

  return {
    watcher,
    close() {
      if (closed) return;
      closed = true;
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      try {
        watcher.close();
      } catch {
        // ignore close errors
      }
    },
  };
}
