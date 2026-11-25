---
name: sf-tree
description: >-
  Read-only dual-mode Tech-Tree View for Software Factory: visualizes Linear work-item dependencies (ready vs. blocked tickets, Critical Path) and docs/factory/ pipeline stages (state validity, review gates, staleness) via snapshots or a live web viewer. Use for roadmaps, ticket blockers, or pipeline status. Do NOT author stages, mutate Linear issues, or run sf-review.
---

# Live Project & Tech-Tree View (`sf-tree`)

**Persona:** Pipeline & Work-Graph Navigator

Provide an instant, strictly read-only interactive view across two complementary tech-trees—without modifying consumer workspace files, mutating tracker state, or adding always-on rules/hooks overhead:

1. **Work Tech-Tree Mode:** Visualizes actual implementation tickets, milestones, `blocks`/`blockedBy` dependency chains, ready/unlocked work, and the estimate-weighted remaining **Critical Path** from Linear (via Linear MCP snapshots or optional direct `LINEAR_API_KEY` GraphQL) or any canonical `work-graph` v1 JSON file.
2. **Pipeline Stages Mode:** Inspects `docs/factory/` planning artifacts (`01-vision.md`–`08-specs.md` + optional `06b-mockery.md`), `<system_state>` validity, `sf-review` audit gates (`reviewed_pass`, `reviewed_fail`, `review_stale`), and upstream-to-downstream staleness blast radius.

## Guardrails (Non-Negotiable)

- **Strictly Read-Only:** NEVER create, edit, or delete files inside the consumer repository working tree (`docs/factory/` or repo root), NEVER mutate Linear issue states/estimates/relations from `sf-tree`, and NEVER auto-invoke downstream authoring skills (`sf-vision`..`sf-specs`, `sf-mockery`, `sf-review`).
- **Zero Repo Pollution for Snapshots:** When exporting a Linear MCP snapshot for `--work-graph <path>`, always write the JSON file to your agent scratch directory or OS temp directory—never inside the consumer git working tree. *(A legacy `docs/factory/work-graph.json` is auto-detected strictly read-only if pre-existing, but never write snapshots into `docs/factory/`.)*
- **Zero Secret Leakage:** When direct Linear GraphQL mode is used, `LINEAR_API_KEY` is read strictly from `process.env.LINEAR_API_KEY`—never written to disk, logged, or returned in JSON/HTTP responses.
- **Zero External Dependencies:** All scripts under `<skill_dir>/scripts/` (`cli.mjs`, `analyzer.mjs`, `analyzer-schema.mjs`, `analyzer-git.mjs`, `work-analyzer.mjs`, `linear-adapter.mjs`, `formatters.mjs`, `server.mjs`, modular `scripts/ui/` assets `index.html`, `app.js`, `dag.js`, `markdown.js`, `styles.css`, and shared `lib/` helpers) run exclusively on Node.js 22+ stdlib.
- **Human-in-the-Loop Handoff Gate:** After displaying a snapshot or launching `--serve`, present the recommended next action(s) and wait for the user to choose what to execute.
- **Prompt Quality Gate (Context-Aware):** Evaluate before running queries or `--serve` (exempt follow-up refinements to an active `sf-tree` view):
  - *High-Signal Check:* Pass silently when mode (`Work Tech-Tree` vs. `Pipeline Stages`), target scope (workspace `docs/factory/` or Linear team/project/`--work-graph` path), and output (`--mermaid`/`--ascii`/`--json` vs. `--serve`) are clear from prompt + workspace context. Pause on vague prompts (e.g., *"What should I work on?"*) when mode or Linear team/project is ambiguous.
  - *Anti-Patterns:* Asking `sf-tree` to mutate `docs/factory/`, update Linear tickets, or auto-run downstream authoring stages (non-overridable; offer a read-only view only).
  - *When Weak/Ambiguous:* Pause in 1 turn with: (1) 1–3 gap/anti-pattern bullets, (2) a suggested High-Signal Prompt with known context + `[placeholders]`, (3) 2–4 targeted follow-up questions, and (4) options to answer & run, edit/accept prompt, or reply `"proceed anyway"`.
  - *Override & Upfront Bypass:* Soft mode/format ambiguities are overridable via `"proceed anyway"`, `"use defaults"`, or `"skip prompt check"` (note chosen mode/scope under **Assumptions Used** in chat). Read-only and zero-repo-pollution guardrails are never overridable.

## Operating Modes

Resolve `<skill_dir>` to the directory containing this `SKILL.md` (where `scripts/cli.mjs` resides) and `<workspace_root>` to the user's current repository root.

### 1. Work Tech-Tree Mode (Linear Projects, Milestones & Ticket Dependencies)

Use Work Tech-Tree Mode whenever the user asks about ticket/issue dependencies, project/milestone progress, what work is ready/unblocked next, or the remaining Critical Path.

#### Mode A — Agent + Linear MCP Snapshot (Zero API Keys Required)

1. Query Linear using your active Linear MCP tools:
   - Call `list_projects` (filtered by team/query as requested) and `list_milestones` for each target project.
   - Call `list_issues` for the target project/team, and fetch `relations` (`blocks` / `blockedBy`) and PR `attachments` (e.g., via `get_issue` with `includeRelations: true`).
2. Normalize the fetched data into canonical `work-graph` v1 JSON (`schema_version: "1.0"`, `graph_type: "work-graph"`, `source`, `projects`, `milestones`, `items`, `edges`—or pass raw MCP JSON through `normalizeLinearMcpPayload()` from `<skill_dir>/scripts/linear-adapter.mjs`) and write it to a scratch/temp path (e.g., `<scratch_dir>/work-graph.json`).
3. Run the CLI against the snapshot:
   ```bash
   # Snapshot outputs (JSON contract, color-coded Mermaid DAG, or terminal ASCII)
   node <skill_dir>/scripts/cli.mjs --work-graph <scratch_dir>/work-graph.json --json
   node <skill_dir>/scripts/cli.mjs --work-graph <scratch_dir>/work-graph.json --mermaid
   node <skill_dir>/scripts/cli.mjs --work-graph <scratch_dir>/work-graph.json --ascii

   # Live interactive web viewer (auto-watches the snapshot via fs.watch + SSE!)
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --work-graph <scratch_dir>/work-graph.json --serve --port 4173 --no-open
   ```
   *(Any subsequent overwrite of `<scratch_dir>/work-graph.json` automatically pushes a live `event: work_graph` SSE update to the open browser viewer without touching the consumer repo.)*

#### Mode B — Optional Direct Linear GraphQL (`LINEAR_API_KEY`)

When the user prefers live direct Linear polling from the terminal without agent MCP mediation:

```bash
# Single Linear project or all active projects in a team (requires LINEAR_API_KEY in env)
node <skill_dir>/scripts/cli.mjs --linear-project P-SOF-6 --ascii
node <skill_dir>/scripts/cli.mjs --linear-team SOF --serve --port 4173 --poll-ms 30000
```

*(Adds a live **Refresh** button calling `POST /api/work-graph/refresh` on `127.0.0.1` alongside optional periodic polling; pass `--poll-ms 0` for manual refresh only, or an integer `>= 5000` ms.)*

#### Work Tech-Tree Snapshot Summary Checklist

When presenting a Work Tech-Tree snapshot in chat, surface:
- **Progress & Points:** Completed/total items and Fibonacci points (`completed_points`/`total_points`, `remaining_points`).
- **Ready / Unlocked Work:** `summary.ready_ids` with each ticket's tailored `next_prompt` and git branch.
- **Remaining Critical Path:** `summary.critical_path_ids` and total `summary.critical_path_points` (estimate-weighted; unestimated defaults to `1`).
- **Blockers & Cycles:** Highlight blocked tickets, active `in_progress`/`in_review` items, and any `cycle_warnings`.
- **Mermaid DAG:** Include the `mermaid` fenced code block emitted by `--mermaid` (thick `==>` edges mark the Critical Path).

### 2. Pipeline Stages Mode (`docs/factory/` 01–08 + Stage 6b Mockery)

Use Pipeline Stages Mode whenever the user asks for `docs/factory/` artifact status, `<system_state>` validity, `sf-review` audit gates, staleness blast radius, or unlocked pipeline stages:

1. Run the zero-dependency CLI against the workspace:
   ```bash
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --view pipeline --json
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --view pipeline --mermaid
   ```
   *(Prefer `--work-graph <scratch_dir>/work-graph.json` or `--linear-project`/`--linear-team` for work graphs. If a legacy `docs/factory/work-graph.json` already exists on disk, `--view auto` detects it read-only; pass `--view pipeline` to force Pipeline Stages. Never write `docs/factory/work-graph.json`. For plain terminals, use `--ascii`.)*
2. Present a concise status summary derived from `--json`:
   - **Project & Progress:** `project_name`, `core_completed`/`core_total`, and optional Stage 6b `sf-mockery` status (`fidelity`, `tokens_synced_from_ui`, screen/component/edge counts, and any `flow.json` parity warnings).
   - **Actionable Gates:** `summary.invalid_phases`, `summary.failing_review_phases` (with `blocking_issues`), `summary.stale_review_phases` (`review_stale` nodes whose `PASS` review is older than a source or target), `summary.stale_phases` + transitive `stale_reasons`, semantic warnings (`Pivot Required`, `wireframe_ready_for_restyle`, `missing_recommended_brd`), and `summary.unlocked_phases` with tailored `next_prompt`.
3. Include the `mermaid` fenced code block emitted by `--mermaid`.
4. **Antigravity Optional Enhancement:** When running inside Antigravity with `generative_ui` available, you may additionally render a compact (`<= 450px`) inline interactive widget from `--json`.

### 3. Live Dual-Mode Web Viewer (`--serve`)

When launching the live HTTP + SSE web viewer (`127.0.0.1`, default port `4173` with automatic free-port fallback):

1. Start the server as a background task / daemon (`--no-open` when opening inside an integrated browser pane or headless terminal; omit `--no-open` to open the system browser).
2. Read the printed `http://127.0.0.1:<port>` URL from stdout and surface it clearly to the user.
3. Highlight the interactive capabilities:
   - Top **Work Tech-Tree | Pipeline Stages** switcher (defaults to `Work Tech-Tree` when a work-graph source is configured; overrideable via `--view`).
   - Project & Milestone scope dropdown, Quick Filters (`All`, `Ready to Start`, `In Progress`, `Blocked`, `Hide Done`), **Highlight Critical Path** (Work Tech-Tree) & **Highlight Stale Blast Radius** (Pipeline Stages) toggles, upstream (`cyan`) & downstream (`violet`) chain hover/click highlighting, clickable Blocker/Unlock jump links, allowlisted `https://` Linear & PR deep links, XSS-safe Markdown preview, and 1-click **Copy Prompt**.
   - Live SSE hot-reload on both `docs/factory/` changes (`event: graph`) and `--work-graph` / Linear polling updates (`event: work_graph`).

### 4. Cross-Harness Degradation & No-Node 22+ Fallback

If `node` is unavailable or older than Node 22 (`node -v` fails or reports `< 22`):

1. Do **not** fail or ask the user to install npm packages.
2. For Pipeline Stages, read `docs/factory/01-vision.md`–`08-specs.md`, optional `06b-mockery.md`, `mockups/flow.json`, and `reviews/*.md` directly, validate `<system_state>` JSON blocks, evaluate staleness/gates, and emit the status summary + Mermaid `flowchart LR` manually.
3. For Work Tech-Tree, inspect the Linear MCP project/issue payloads directly, compute ready vs. blocked status and Critical Path manually, and emit the summary + Mermaid `flowchart LR`, noting that Node.js 22+ unlocks `--json` and the live `--serve` UI.

## CLI Reference (`scripts/cli.mjs`)

| Flag | Description |
| :--- | :--- |
| `--dir <path>` | Target consumer workspace directory (defaults to current working directory). |
| `--work-graph <path>` | Path to canonical `work-graph` v1 JSON snapshot (prefer out-of-repo scratch path; watched live via `fs.watch` in `--serve`). |
| `--linear-project <id\|slug\|name>` | Fetch live single Linear project directly via `LINEAR_API_KEY` (Node 22 native `fetch`). |
| `--linear-team <key\|name>` | Fetch all active Linear projects in a team directly via `LINEAR_API_KEY`. |
| `--poll-ms <num>` | Live Linear polling interval in ms for `--serve` (default `30000`; validated integer `>= 5000`, or `0` to disable periodic polling). |
| `--view <auto\|work\|pipeline>` | Select view mode (default `auto`: `work` if `--work-graph`/Linear is configured or a legacy read-only `docs/factory/work-graph.json` pre-exists, else `pipeline`). |
| `--json` | Emit strict v1 Graph JSON (`work-graph` or pipeline). |
| `--mermaid` | Emit deterministic color-coded Mermaid `flowchart LR` DAG. |
| `--ascii` | Emit terminal-friendly ASCII tech-tree (default if no mode flag is passed). |
| `--serve` | Start strictly read-only `127.0.0.1` HTTP + SSE live viewer (modular `scripts/ui/`). |
| `--port <num>` | Preferred port for `--serve` (validated integer `0..65535`, default `4173`; auto-falls back to a free port if busy). |
| `--no-open` | Skip auto-opening the system browser when starting `--serve`. |

## Handoff

Summarize the active tech-tree state (Work Tech-Tree ready work + Critical Path and/or Pipeline Stages gates + unlocked stages), list the exact next recommended prompt(s), and pause for the user's decision.
