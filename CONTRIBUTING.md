# Contributing to Software Factory

Thank you for contributing to **Software Factory** (`software-factory-plugin`)!

## Core Engineering Guardrails

1. **Zero Always-On Rules/Hooks Overhead (Router-Only Metadata):** Never add always-on rule files (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `rules/`), hooks (`hooks.json`), or bundled MCP servers (`mcp_config.json`) to this plugin repository. Only lightweight skill router frontmatter should load at idle.
2. **Keep `docs/factory/` Out of This Repo:** Pipeline artifacts (`docs/factory/*.md`) belong only in *consumer* repositories using the plugin—never commit them here.
3. **Node.js 22+ Stdlib Only:** All scripts and tests under `lib/`, `skills/*/scripts/`, `tests/`, `evals/`, and `scripts/` must run on Node.js 22+ standard library with zero external npm dependencies and zero build step.
4. **Synced Cross-Harness Manifests:** Keep `version` and `description` synchronized across all 6 plugin and marketplace manifests:
   - `plugin.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json`
   - `.codex-plugin/plugin.json`
   - `.agents/plugins/marketplace.json`
   - `gemini-extension.json`

   Use `node scripts/bump-version.mjs <semver>` when cutting releases.

## Local Verification Checklist

Before opening a pull request, run all four checks (requires Node.js 22+):

```bash
# 1. Verify manifest & README version parity across all 6 manifests
node scripts/bump-version.mjs --check

# 2. Run the Node.js 22+ unit, security, and regression test suites
node --test tests/*.test.mjs

# 3. Run the 4-suite offline eval harness (skills, schemas, guards, tokens)
node evals/run.mjs --ascii

# 4. Run strict Antigravity plugin validation (if agy CLI is installed)
agy plugin validate --strict .
```

## Public Issue Triage

Bug reports and feature requests submitted via GitHub Issues are triaged by maintainers and mirrored into internal tracking with a link back to the original GitHub issue.
