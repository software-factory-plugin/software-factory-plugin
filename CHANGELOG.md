# Changelog

All notable changes to `software-factory-plugin` are documented in this file.

## [0.9.0] — 2026-11-24

### Added (Bundled Mockery Runtime & Standalone Offline Export)
- Folded the zero-dependency Node.js 20+ Mockery runtime directly into `skills/sf-mockery/scripts/` (`cli.mjs`, `check.mjs`, `server.mjs`, `export.mjs`, and `viewer/`), eliminating any external Mockery repo, `npm`, or `npx` requirement on fresh machines.
- Added `export` (`node skills/sf-mockery/scripts/cli.mjs export docs/factory/mockups`) to compile a Mockery flow canvas (`flow.json`, `tokens.css`, `kit.css`, optional `fonts.css`, `components/*.html`, `screens/*.html`, local `assets/*` as base64 `data:` URIs, and the canvas viewer) into a single self-contained `preview.html` that opens over `file://` with zero server or Node.js runtime required.
- Updated `skills/sf-mockery/SKILL.md`, `skills/sf-tree` (`analyzer.mjs`, `formatters.mjs`, `ui.html`), `README.md`, and `docs/PROMPTING_GUIDE.md` to use the bundled zero-dependency CLI for `check`, `serve`, and `export`.
- Completed the golden PulseBoard mockup fixture under `evals/fixtures/pulseboard/mockups/` and added automated `checkProject`, negative `<script>` lint, and `exportProject` JS-syntax validation checks to `evals/suites/golden-schemas.mjs` (`156/156` checks passing; zero added idle router token overhead).

## [0.8.0] — 2026-11-24

### Added (Built-In Prompt Quality Gate)
- Added a tailored, context-aware **Prompt Quality Gate** to all 12 skills (`sf-vision` through `sf-specs`, `sf-mockery`, `sf-review`, `sf-tree`, and `sf-telemetry`) with zero added idle router token overhead (`~1324/1500` est tokens).
- Downstream skills resolve `docs/factory/` upstream `<system_state>` blocks first so clear concise prompts and targeted revisions pass silently; weak/ambiguous prompts pause in 1 turn with gap diagnosis, a suggested High-Signal Prompt using explicit `[placeholders]`, 2–4 targeted follow-up questions, and soft override/upfront bypass support (`"proceed anyway"`, `"use defaults"`, `"skip prompt check"`) with **Assumptions Used** transparency.
- Preserved non-overridable hard invariants (Missing-Input Guard, multi-stage bundling prevention, `sf-review` no-rewrite, `sf-tree` read-only, and `sf-telemetry` 8-point epic split gate).
- Added 12 `guard-prompt-quality-gate:<skill>` automated contract checks in `evals/suites/guards-review.mjs` (`153/153` checks passing) and documented the gate in `docs/PROMPTING_GUIDE.md`.

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
