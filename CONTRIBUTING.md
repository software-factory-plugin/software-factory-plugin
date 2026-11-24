# Contributing to Software Factory

Thank you for contributing to **Software Factory** (`software-factory-plugin`)!

## Core Engineering Guardrails

1. **Zero Idle Token Overhead:** Never add always-on rule files (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `rules/`), hooks (`hooks.json`), or bundled MCP servers (`mcp_config.json`) to this plugin repository.
2. **Keep `docs/factory/` Out of This Repo:** Pipeline artifacts (`docs/factory/*.md`) belong only in *consumer* repositories using the plugin—never commit them here.
3. **Node.js 20+ Stdlib Only:** All scripts under `skills/*/scripts/`, `evals/`, and `scripts/` must run on Node.js 20+ standard library with zero external npm dependencies and zero build step.
4. **Synced Cross-Harness Manifests:** Keep `version` and `description` synchronized across `plugin.json`, `.claude-plugin/plugin.json`, and `gemini-extension.json`. Use `node scripts/bump-version.mjs <semver>` when cutting releases.

## Local Verification Checklist

Before opening a pull request, run all three checks:

```bash
# 1. Verify manifest & README version parity
node scripts/bump-version.mjs --check

# 2. Run the 4-suite offline eval harness (skills, schemas, guards, tokens)
node evals/run.mjs --ascii

# 3. Run strict Antigravity plugin validation (if agy CLI is installed)
agy plugin validate --strict .
```

## Public Issue Triage

Bug reports and feature requests submitted via GitHub Issues are triaged by maintainers and mirrored into internal tracking with a link back to the original GitHub issue.
