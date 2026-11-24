# Changelog

All notable changes to `software-factory-plugin` are documented in this file.

## [0.7.1] — 2026-11-24

### Added (Cross-Harness Marketplace Expansion)
- Added OpenAI Codex plugin manifest (`.codex-plugin/plugin.json`) and marketplace catalog (`.agents/plugins/marketplace.json`).
- Added self-hosted Claude Code marketplace catalog (`.claude-plugin/marketplace.json`, `"source": "./"`).
- Extended `scripts/bump-version.mjs` and `evals/suites/skills-audit.mjs` to validate and synchronize all 6 plugin/marketplace manifests alongside `README.md`.

## [0.7.0] — 2026-11-24

### Added (Track #6 — Marketplace Publishing)
- Added MIT `LICENSE` and minimal 128×128 geometric DAG SVG logo (`assets/logo.svg`) referenced via `plugin.json`.
- Completed cross-harness metadata across `plugin.json` (Antigravity), `.claude-plugin/plugin.json` (Claude Code), and `gemini-extension.json` (Gemini CLI).
- Added zero-dep release version-sync utility (`scripts/bump-version.mjs --check | <semver>`) wired into CI and eval packaging checks.
- Added `CONTRIBUTING.md`, `CHANGELOG.md`, and `.github/ISSUE_TEMPLATE/` public issue templates.
- Achieved zero-warning, zero-notice strict validation under `agy plugin validate --strict .`.

## [0.6.0] — 2026-11-24

### Added (Track #5 — Prompting Guide & Evals)
- Added operator prompting handbook (`docs/PROMPTING_GUIDE.md`) covering all 12 skills, recovery playbooks, and cross-harness tips with zero idle router token load.
- Added zero-dep automated eval suite (`evals/run.mjs`, 4 suites, golden PulseBoard fixtures) and GitHub Actions CI (`.github/workflows/ci.yml`).

## [0.5.0] — 2026-11-24

### Added (Track #4 — Agile Sizing & Token/Cost Telemetry)
- Added on-demand `sf-telemetry` skill and zero-dep Node 20+ CLI (`size-check`, `log`, `import-bootstrap`, `import-transcript`, `report`, `format-comment`) with offline model pricing, out-of-repo JSONL storage, and automatic scope/cost blowup alerts.

## [0.4.0] — 2026-11-24

### Added (Track #3b — Work-Item Tech-Tree / `sf-tree` v2)
- Upgraded `sf-tree` to dual-mode **Work Tech-Tree** + **Pipeline Stages** with canonical `work-graph` v1 analyzer, Kahn's topological tiers + cycle guard, remaining estimate-weighted Critical Path, Linear MCP & GraphQL adapters, live `fs.watch` + SSE updates, and dual-mode `ui.html`.

## [0.3.0] — 2026-11-24

### Added (Track #3 — Live Project & Tech-Tree View)
- Added read-only `sf-tree` skill with zero-dep DAG analyzer, staleness blast-radius engine, `--json`/`--mermaid`/`--ascii` formatters, and live `127.0.0.1` HTTP + SSE web viewer.

## [0.2.0] — 2026-11-23

### Added (Track #2 — Mockery Integration)
- Added optional Stage 6b `sf-mockery` bridge skill (styled & wireframe modes), `sf-ux`/`sf-ui`/`sf-architecture` optional hooks, and `sf-review` Mockery Red Team checks.

## [0.1.0] — 2026-11-23

### Added (Initial Release)
- Initial 9-skill DAG pipeline (`sf-vision` through `sf-specs` + universal `sf-review` Red Team auditor) with 80/20 hybrid artifacts and strict `<system_state>` handoffs.
