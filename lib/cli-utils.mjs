// Shared CLI, escaping, hashing, and runtime guard utilities (Node 20+ built-ins only).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SAFE_SHELL_TOKEN_RE = /^[a-zA-Z0-9._/@:-]+$/;

/**
 * Enforce the Node.js 20+ minimum runtime requirement with an actionable error.
 */
export function assertNode20(minMajor = 20) {
  const major = Number(String(process.versions.node || "0").split(".")[0]);
  if (!Number.isFinite(major) || major < minMajor) {
    throw new Error(
      `software-factory requires Node.js >= ${minMajor}.0.0 (detected v${process.versions.node || "unknown"}).`
    );
  }
}

/**
 * Return true only when the module at `importMetaUrl` is the directly invoked CLI entrypoint.
 */
export function isDirectRun(importMetaUrl) {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const self = path.resolve(fileURLToPath(importMetaUrl));
  if (entry === self) return true;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return false;
  }
}

/**
 * Escape HTML text and attribute values, including single quotes (&#39;).
 */
export function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * POSIX-safe single-quoting for shell command snippets displayed to users.
 * Always quotes strings containing whitespace, shell metacharacters, or leading dashes.
 */
export function posixShellQuote(value) {
  const str = String(value ?? "");
  if (str.length > 0 && !str.startsWith("-") && SAFE_SHELL_TOKEN_RE.test(str)) {
    return str;
  }
  return `'${str.replaceAll("'", "'\\''")}'`;
}

/**
 * Convert a platform filesystem path to forward-slash POSIX notation.
 */
export function toPosixPath(filePath) {
  return String(filePath ?? "").split(path.sep).join("/");
}

/**
 * Deterministic short SHA-256 hex digest (used for non-PII project/workspace identifiers).
 */
export function hashShort(value, length = 12) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
    .slice(0, Math.max(4, length));
}
