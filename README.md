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
| `sf-tree` *(read-only)* | *(inspector)* | Existing workspace `docs/factory/` (optional; handles empty repos) | v1 Graph JSON (`nodes`, `edges`, `summary`, `mockery`), Mermaid DAG, ASCII tree, or live web UI | *(read-only; writes zero files)* |

## Live Project & Tech-Tree View (`sf-tree`)

Invoke `sf-tree` at any point to inspect pipeline progress, `<system_state>` validity, `sf-review` gates, upstream-to-downstream staleness blast radius, and optional Stage 6b `sf-mockery` parity—powered by zero-dependency Node.js 20+ scripts under `skills/sf-tree/scripts/`:

- **Snapshot Mode (default):** Emits a concise status summary (completed stages, unlocked next stages, stale/failing review gates, semantic warnings) plus a color-coded Mermaid DAG in chat. On Antigravity, the agent may optionally render a compact (`<= 450px`) inline interactive widget from `--json`.
- **Live Local Web Viewer (`--serve`):** Starts a strictly read-only HTTP + Server-Sent Events server on `127.0.0.1` (default port `4173` with automatic free-port fallback) watching `docs/factory/`, `docs/factory/reviews/`, and `docs/factory/mockups/flow.json`. Includes a layered SVG/HTML DAG, light/dark themes, upstream/downstream & **Highlight Stale Blast Radius** toggles, a 3-tab inspector (**Overview/`<system_state>`**, XSS-safe **Narrative**, **Reviews**), 1-click **Copy Prompt** helpers, and Stage 6b Mockery viewer/check shortcuts.
- **Cross-Harness Graceful Degradation:** Identical `--json`, `--mermaid`, `--ascii`, and `--serve` behavior across Antigravity, Claude Code, and Gemini CLI with zero external npm dependencies. If Node.js 20+ is unavailable, `sf-tree` falls back to reading `docs/factory/*.md` directly and emitting the status summary + Mermaid DAG manually.

```bash
# Snapshot outputs (JSON contract, color-coded Mermaid DAG, or terminal ASCII)
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --json
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --mermaid
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --ascii

# Launch the live hot-reloading web viewer on 127.0.0.1:4173 (add --no-open for headless)
node skills/sf-tree/scripts/cli.mjs --dir /path/to/repo --serve --port 4173
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

## Installation & Versioning

### Antigravity

Validate and install locally or from a versioned Git tag:

```bash
# Validate the plugin bundle
agy plugin validate --strict /path/to/software-factory-plugin

# Install from a local checkout
agy plugin install /path/to/software-factory-plugin

# Or install a pinned version from GitHub
agy plugin install https://github.com/software-factory-plugin/software-factory-plugin/tree/v0.2.0
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
- **Live Project & Tech-Tree View (Shipped):** Read-only `sf-tree` skill and zero-dep Node 20+ DAG analyzer/live SSE web viewer for pipeline status, staleness blast radius, `sf-review` gates, and Mockery parity.
- **Agile Sizing & Token/Cost Telemetry:** Fibonacci sizing calibration paired with actual LLM token, cost, and rework tracking.
- **Prompting Guide & Evals:** End-to-end prompting handbook and automated evaluation suite for skill output quality and `<system_state>` fidelity.
- **Marketplace Publishing:** Packaging, validation, and distribution across Antigravity, Claude Code, and Gemini CLI marketplaces.
