# Software Factory (`software-factory`)

A lightweight, Directed Acyclic Graph (DAG) suite of agentic skills for building software through staged, human-validated phases without schema bloat or context drift.

## Core Design Principles

1. **80/20 Hybrid Artifact (Dual-Format):** Every pipeline skill produces a single markdown artifact made of ~80% human-readable narrative (for review and discussion) and ~20% machine-readable strict JSON inside a trailing `<system_state>...</system_state>` block.
2. **Strict `<system_state>` Handoff:** Downstream skills ingest upstream `<system_state>` blocks as hard ground truth. When working in a workspace, each stage writes its artifact under `docs/factory/` and downstream skills check explicit prompt inputs, current conversation turns, and `docs/factory/` in order before triggering the Missing-Input Guard; if required upstream state is still missing, downstream skills pause rather than inventing requirements.
3. **Universal Adversarial Reviewer (`sf-review`):** One parameterized Red Team skill audits any downstream Target artifact against one or more upstream Source artifacts, checking for constraint violations, scope creep, missing logic, and `<system_state>` validity/parity.

> **Zero Idle Token Overhead:** This plugin intentionally omits always-on rule files (`rules/AGENTS.md` / `GEMINI.md`). Only skill names and descriptions load into the router until you activate a stage.

## Pipeline DAG

```mermaid
flowchart LR
    V["1. sf-vision\n01-vision.md"] --> MR["2. sf-market-research\n02-market-research.md"]
    V --> BRD["3. sf-brd\n03-brd.md"]
    MR --> BRD
    V --> PRD["4. sf-prd\n04-prd.md"]
    BRD --> PRD
    V --> UX["5. sf-ux\n05-ux.md"]
    PRD --> UX
    V --> UI["6. sf-ui\n06-ui.md"]
    UX --> UI
    UX -. "optional wireframe" .-> MOCK["6b. sf-mockery (Optional)\n06b-mockery.md + mockups/"]
    UI -. "optional styled" .-> MOCK
    V -.-> MOCK
    V --> ARCH["7. sf-architecture\n07-architecture.md"]
    BRD -. "recommended" .-> ARCH
    PRD --> ARCH
    UX --> ARCH
    UI --> ARCH
    MOCK -. "optional" .-> ARCH
    V --> SPECS["8. sf-specs\n08-specs.md"]
    PRD --> SPECS
    ARCH --> SPECS
    REV(["sf-review\nRed Team Audit Gate"]) -. "audits any Source vs Target" .-> ARCH
```

## Skill Reference

| Skill | Phase | Required Upstream Inputs | `<system_state>` Outputs | Canonical Artifact Path |
| :--- | :--- | :--- | :--- | :--- |
| `sf-vision` | `vision` | Initial idea + constraints | `project_name`, `primary_user`, `ux_tone`, `hard_constraints`, `explicitly_out_of_scope` | `docs/factory/01-vision.md` |
| `sf-market-research` | `market-research` | `sf-vision` | `competitors`, `market_gap_defined`, `validation_status`, `identified_risks` | `docs/factory/02-market-research.md` |
| `sf-brd` | `brd` | `sf-vision`, `sf-market-research` | `monetization_model`, `core_kpis`, `compliance_requirements`, `budget_or_timeline_constraints` | `docs/factory/03-brd.md` |
| `sf-prd` | `prd` | `sf-vision`, `sf-brd` | `core_flows`, `business_rules`, `required_integrations`, `edge_case_mitigations` | `docs/factory/04-prd.md` |
| `sf-ux` | `ux` | `sf-prd`, `sf-vision` | `screens_required`, `primary_navigation_pattern`, `key_interactions`, `accessibility_requirements` | `docs/factory/05-ux.md` |
| `sf-ui` | `ui` | `sf-vision`, `sf-ux` | `css_framework_recommendation`, `color_palette`, `typography`, `border_radius_base` | `docs/factory/06-ui.md` |
| `sf-mockery` *(optional)* | `mockery` | `sf-vision`, `sf-ux`, `sf-ui` (`sf-ui` optional in wireframe mode) | `fidelity`, `mockups_dir`, `devices`, `sections`, `screens`, `components`, `edges_count`, `tokens_synced_from_ui` | `docs/factory/06b-mockery.md` + `docs/factory/mockups/` |
| `sf-architecture` | `architecture` | `sf-prd`, `sf-ux`, `sf-ui`, `sf-vision` (`sf-brd` recommended; `sf-mockery` optional) | `frontend_stack`, `backend_stack`, `database_type`, `data_models`, `core_endpoints` | `docs/factory/07-architecture.md` |
| `sf-specs` | `specs` | `sf-prd`, `sf-architecture`, `sf-vision` | `openapi_stubs`, `required_unit_tests`, `required_e2e_tests`, `linter_rules` | `docs/factory/08-specs.md` |
| `sf-review` | `review` | 1+ upstream Source artifact(s) + 1 Target artifact | `source_phases`, `target_phase`, `verdict`, `critical_violations_count`, `scope_creep_warnings_count`, `blocking_issues` | `docs/factory/reviews/<source>-vs-<target>-review.md` |
| `sf-tree` *(read-only)* | *(inspector)* | Workspace `docs/factory/` and/or Linear / `work-graph` v1 JSON | Dual-mode v1 JSON (Work Tech-Tree & Pipeline Stages), Mermaid DAG, ASCII tree, or live web UI | *(read-only; writes zero repo files)* |
| `sf-telemetry` *(on-demand)* | *(calibration)* | Fibonacci estimate + optional Linear comments or agent JSONL transcript | Canonical v1 JSONL records, Linear closing comments, calibration & blowup reports (`--json`/`--markdown`/`--ascii`) | Out-of-repo `~/.config/software-factory/telemetry/<slug>.jsonl` |

## Live Project & Tech-Tree View (`sf-tree`)

Invoke `sf-tree` at any point to visualize either your **Work-Item / Ticket Dependency Tech-Tree** (Linear projects, milestones, `blocks`/`blockedBy` chains, ready vs. blocked work, estimate-weighted remaining Critical Path) or your **01–08 Pipeline Stages** (`docs/factory/` progress, `<system_state>` validity, `sf-review` gates, staleness blast radius, and Stage 6b Mockery parity)—powered by zero-dependency Node.js 20+ scripts under `skills/sf-tree/scripts/`:

- **Work Tech-Tree Mode (`--work-graph` / `--linear-project` / `--linear-team`):** Normalizes Linear MCP snapshots (`--work-graph <scratch-path>`, zero API keys required) or optional live Linear GraphQL (`LINEAR_API_KEY`, Node 20 native `fetch`) into canonical `work-graph` v1 JSON, computes deterministic Kahn's topological tiers (with cycle guard), derives `DONE` / `IN REVIEW` / `IN PROGRESS` / `READY` / `BLOCKED` status, and calculates the estimate-weighted remaining Critical Path.
- **Pipeline Stages Mode (`--dir`):** Emits a concise status summary (completed stages, unlocked next stages, stale/failing review gates, semantic warnings) plus a color-coded Mermaid DAG in chat.
- **Dual-Mode Live Local Web Viewer (`--serve`):** Starts a strictly read-only HTTP + Server-Sent Events server on `127.0.0.1` (default port `4173` with automatic free-port fallback) featuring a **Work Tech-Tree | Pipeline Stages** switcher, Project/Milestone filter dropdown, Quick Filters (`All`, `Ready to Start`, `In Progress`, `Blocked`, `Hide Done`), **Highlight Critical Path** & **Highlight Stale Blast Radius** toggles, clickable Blocker/Unlock jump links, allowlisted `https://` Linear/PR deep links, XSS-safe Markdown preview, and 1-click **Copy Prompt** helpers.
- **Cross-Harness Graceful Degradation:** Identical `--json`, `--mermaid`, `--ascii`, and `--serve` behavior across Antigravity, Claude Code, and Gemini CLI with zero external npm dependencies and zero repo pollution.

```bash
# Work Tech-Tree from an agent-generated Linear MCP snapshot (or docs/factory/work-graph.json)
node skills/sf-tree/scripts/cli.mjs --work-graph /path/to/scratch/work-graph.json --mermaid
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --work-graph /path/to/scratch/work-graph.json --serve --port 4173

# Optional direct Linear GraphQL polling (reads LINEAR_API_KEY from env; never persisted)
node skills/sf-tree/scripts/cli.mjs --linear-team SOF --serve --port 4173 --poll-ms 30000

# Pipeline Stages snapshot outputs or live viewer
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --view pipeline --json
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --view pipeline --mermaid
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --serve --port 4173
```

## Agile Sizing & Token/Cost Telemetry (`sf-telemetry`)

Invoke `sf-telemetry` on demand to validate Fibonacci estimates (`1, 2, 3, 5, 8` with mandatory split gate on `8`-pt epics), record model/token/cost/rework telemetry to an out-of-repo JSONL store (`~/.config/software-factory/telemetry/<slug>.jsonl`), import Linear bootstrap telemetry comments or local agent JSONL transcripts, and generate calibration & blowup reports—with **0 hooks**, **0 rules**, and zero external npm dependencies:

```bash
# Enforce 8-point epic split gate
node skills/sf-telemetry/scripts/cli.mjs size-check --estimate 5 --json

# Log telemetry (auto-estimates USD from built-in offline pricing table when tokens are given)
node skills/sf-telemetry/scripts/cli.mjs log --issue SOF-26 --model "Gemini 4 Neon (High)" --estimate 5 --felt 3 --execution smooth

# Import Linear bootstrap comments or local agent JSONL transcript, then generate calibration report
node skills/sf-telemetry/scripts/cli.mjs import-bootstrap --input /path/to/scratch/comments.json
node skills/sf-telemetry/scripts/cli.mjs report --markdown
```

## Optional Interactive Mockups (`sf-mockery`)

Between UX/UI and Architecture, you can optionally invoke `sf-mockery` to generate a clickable, pannable **Mockery** flow canvas under `docs/factory/mockups/` (`flow.json`, static HTML screens, reusable `<x-include>` partials, `tokens.css`, `kit.css`) alongside `docs/factory/06b-mockery.md`:

- **Styled Mode (default, after `sf-ui`):** Maps `sf-ux` screens/transitions and `sf-ui` design tokens directly into `docs/factory/mockups/`.
- **Wireframe Mode (optional, after `sf-ux`):** Generates neutral grayscale screens so you can inspect flows before `sf-ui`, then restyles `tokens.css` and `kit.css` in place after `sf-ui` completes.
- **Zero Lock-In & Pure File-Only Fallback:** Baseline `sf-ux` → `sf-ui` → `sf-architecture` works identically without Mockery installed. When Mockery is installed in your project, preview and validate the canvas locally:

```bash
# Validate flow.json, screens, components, edges, and static lints (Mockery v0.3.0+)
npx mockery check docs/factory/mockups

# Start the live hot-reload flow canvas viewer (auto-detects docs/factory/mockups on v0.3.0+)
npx mockery docs/factory/mockups
```

## Prompting Guide & Automated Evals

- **Operator Prompting Guide:** See [`docs/PROMPTING_GUIDE.md`](docs/PROMPTING_GUIDE.md) for copy-paste starter prompts across all 12 skills, high-signal vs. anti-pattern prompt comparisons, recovery playbooks (Missing-Input Guard, `sf-review FAIL`, stale blast radius, 8-pt epic splits), and cross-harness tips.
- **Zero-Dependency Eval Suite (`evals/run.mjs`):** Deterministically audits all 12 skills, golden end-to-end PulseBoard `<system_state>` schemas + negative defect cases, Missing-Input Guard & `sf-review` coverage, and idle router token budgets (CI-enforced via `.github/workflows/ci.yml`):

```bash
# Run all 4 eval suites (skills, schemas, guards, tokens) offline with Node 20+
node evals/run.mjs --ascii
node evals/run.mjs --markdown
node evals/run.mjs --json
```

## Installation & Versioning

### Antigravity

Validate and install locally or from a versioned Git tag:

```bash
# Validate the plugin bundle
agy plugin validate --strict /path/to/software-factory-plugin

# Install from a local checkout
agy plugin install /path/to/software-factory-plugin

# Or install a pinned version from GitHub
agy plugin install https://github.com/software-factory-plugin/software-factory-plugin/tree/v0.5.0
```

Alternatively, register the local directory in `~/.gemini/config/plugins.json` (global) or `.agents/plugins.json` (workspace):

```json
{
  "entries": [
    { "path": "/path/to/software-factory-plugin" }
  ]
}
```

### Claude Code

Uses `.claude-plugin/plugin.json` together with the shared `skills/` directory at the repository root. Point Claude Code's plugin loader at this repository directory or marketplace entry.

### Gemini CLI

Link the local checkout during development using `gemini-extension.json`:

```bash
gemini extensions link .
```

### Releasing a New Version

Keep `version` synchronized across all three manifests before tagging a release:
1. `plugin.json`
2. `.claude-plugin/plugin.json`
3. `gemini-extension.json`

Then commit and push a matching Git tag (for example, `v0.1.0`).

## Roadmap

Active roadmap planning, design specs, and issue tracking live in [Linear (`SOF`)](https://linear.app/software-factory-plugin):

- **Mockery Integration (Shipped):** Optional `sf-mockery` bridge skill connecting interactive Mockery flow canvases into UX/UI, `sf-review`, and `sf-architecture`.
- **Live Project & Tech-Tree View (Shipped):** Dual-mode read-only `sf-tree` skill and zero-dep Node 20+ DAG analyzer/live SSE web viewer covering both Work-Item / Linear Dependency Tech-Trees (topological tiers, ready vs. blocked work, Critical Path) and 01–08 Pipeline Stages (staleness blast radius, `sf-review` gates, Mockery parity).
- **Agile Sizing & Token/Cost Telemetry (Shipped):** On-demand `sf-telemetry` skill and zero-dep Node 20+ CLI pairing Fibonacci sizing (`1, 2, 3, 5, 8`) with offline token/cost pricing, Linear bootstrap & transcript parsers, out-of-repo JSONL storage, and calibration/blowup reports.
- **Prompting Guide & Evals (Shipped):** Comprehensive operator handbook (`docs/PROMPTING_GUIDE.md`) plus zero-dep Node 20+ automated eval suite (`evals/run.mjs`, golden PulseBoard fixtures, 4 suites, GitHub Actions CI) verifying frontmatter, `<system_state>` fidelity, Missing-Input Guards, `sf-review` vectors, and idle-router token budgets.
- **Marketplace Publishing:** Packaging, validation, and distribution across Antigravity, Claude Code, and Gemini CLI marketplaces.
