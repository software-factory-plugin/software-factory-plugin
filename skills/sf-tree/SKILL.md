---
name: sf-tree
description: >-
  Read-only Live Project & Tech-Tree View for the Software Factory pipeline. Inspects docs/factory/ artifacts, <system_state> validity, sf-review audit gates, optional Stage 6b sf-mockery status, and upstream-to-downstream staleness/blast radius. Supports Snapshot Mode (status summary + color-coded Mermaid DAG, default), CLI outputs (--json, --mermaid, --ascii), and Live Local Web Viewer (--serve with SSE hot-reload). Use when asked for pipeline status, project progress, tech-tree/DAG visualization, stale artifact checks, or next unlocked stages. Do NOT use to author pipeline stages (sf-vision..sf-specs, sf-mockery) or run adversarial audits (sf-review).
---

# Live Project & Tech-Tree View (`sf-tree`)

**Persona:** Pipeline Inspector / Release Navigator

Provide an instant, strictly read-only view of a consumer workspace's Software Factory pipeline under `docs/factory/`. Surface completed stages, unlocked next stages, `<system_state>` validity, `sf-review` pass/fail/freshness gates, upstream-to-downstream staleness blast radius, and optional Stage 6b `sf-mockery` parity—without modifying workspace files or adding idle token overhead.

## Guardrails (Non-Negotiable)

- **Strictly Read-Only:** NEVER create, edit, or delete files under `docs/factory/`, never write cache or temp files into the consumer workspace, and never auto-advance or invoke downstream authoring skills (`sf-vision`..`sf-specs`, `sf-mockery`, `sf-review`).
- **Zero External Dependencies:** The bundled scripts under `<skill_dir>/scripts/` (`cli.mjs`, `analyzer.mjs`, `formatters.mjs`, `server.mjs`, `ui.html`) run exclusively on Node.js 20+ stdlib.
- **Human-in-the-Loop Handoff Gate:** After displaying the snapshot or launching the live viewer, present the recommended next action(s) and wait for the user to choose what to run next.

## Operating Modes

Resolve `<skill_dir>` to the directory containing this `SKILL.md` (where `scripts/cli.mjs` resides) and `<workspace_root>` to the user's current repository root.

### 1. Snapshot Mode (Default)

Use Snapshot Mode whenever the user asks for pipeline status, progress, tech-tree overview, stale checks, or what stage is unlocked next (unless they explicitly ask to open/launch the live web viewer):

1. Run the zero-dependency CLI against the workspace to retrieve both structured state and the color-coded DAG:
   ```bash
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --json
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --mermaid
   ```
   *(For plain headless terminals without Mermaid rendering, run `--ascii` instead.)*
2. Present a concise status summary derived from the `--json` output:
   - **Project & Progress:** `project_name`, core progress (`core_completed`/`core_total`), and optional Stage 6b `sf-mockery` status (`fidelity`, `tokens_synced_from_ui`, screen/component/edge counts, and any `flow.json` parity warnings).
   - **Actionable Gates:**
     - **Invalid `<system_state>`:** List `invalid_phases` and their `state_errors`.
     - **Failing or Stale Reviews:** List `failing_review_phases` (with `blocking_issues`) and any latest review with `is_stale: true`.
     - **Stale Blast Radius:** List `stale_phases` and their `stale_reasons` (noting transitive downstream propagation).
     - **Semantic Warnings:** Highlight `Pivot Required` on `market-research`, `wireframe_ready_for_restyle` / parity drift on `mockery`, or `missing_recommended_brd` on `architecture`.
     - **Unlocked Next Stages:** List `unlocked_phases` and each node's tailored `next_prompt`.
3. Include the `mermaid` fenced code block emitted by `--mermaid`.
4. **Antigravity Optional Enhancement:** When running inside Antigravity with the `generative_ui` skill available and the user benefits from visual scanning, you may additionally render a compact (`<= 450px` tall) inline interactive tech-tree widget directly from the `--json` payload alongside the summary.
5. Offer the exact command to launch the live interactive web viewer if the user wants real-time file watching, narrative inspection, blast-radius highlighting, and 1-click Copy Prompt buttons:
   ```bash
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --serve
   ```

### 2. Live Tech-Tree Web Viewer (`--serve`)

Use Live Viewer Mode when the user asks to launch, open, or watch the live interactive tech-tree UI:

1. Start the local HTTP + SSE server as a background task / daemon (bound strictly to `127.0.0.1`, default port `4173` with automatic free-port fallback):
   ```bash
   node <skill_dir>/scripts/cli.mjs --dir <workspace_root> --serve --port 4173 --no-open
   ```
   *(Omit `--no-open` when the user wants their system browser opened automatically; keep `--no-open` when opening the URL inside an integrated browser pane or headless terminal.)*
2. Read the printed `http://127.0.0.1:<port>` URL from stdout and surface it clearly to the user:
   - **Antigravity:** Open or link `http://127.0.0.1:<port>` (in the built-in browser pane if requested, or as a clickable link).
   - **Claude Code & Gemini CLI:** Print the clickable `http://127.0.0.1:<port>` URL and remind the user it updates live via Server-Sent Events (`/events`) whenever files under `docs/factory/` change.
3. Remind the user the server is strictly read-only, watches `docs/factory/`, `docs/factory/reviews/`, and `docs/factory/mockups/flow.json`, and exits cleanly on `Ctrl+C` or when stopped.

### 3. Cross-Harness Degradation & No-Node 20+ Fallback

If `node` is unavailable or older than Node 20 (`node -v` fails or reports `< 20`):

1. Do **not** fail or ask the user to install npm packages.
2. Inspect the workspace directly with your file-reading tools:
   - Check `docs/factory/01-vision.md` through `docs/factory/08-specs.md`, optional `docs/factory/06b-mockery.md`, `docs/factory/mockups/flow.json`, and `docs/factory/reviews/*.md`.
   - Parse each file's trailing `<system_state>...</system_state>` JSON block and verify `"phase"` and required stage keys.
   - Determine each stage's status (`locked`, `unlocked`, `invalid`, `unreviewed`, `reviewed_pass`, `reviewed_fail`), check upstream vs. downstream modification/git commit recency for staleness, and surface semantic warnings (`Pivot Required`, `wireframe_ready_for_restyle`, `missing_recommended_brd`, `flow.json` parity).
3. Emit the exact same concise status table, recommended next prompts, and color-coded `flowchart LR` Mermaid DAG manually, noting that installing Node.js 20+ unlocks `--json` and the live `--serve` web UI.

## CLI Reference (`scripts/cli.mjs`)

| Flag | Description |
| :--- | :--- |
| `--dir <path>` | Target consumer workspace directory (defaults to current working directory). |
| `--json` | Emit strict v1 Graph JSON (`schema_version: "1.0"`). |
| `--mermaid` | Emit deterministic color-coded Mermaid `flowchart LR` DAG. |
| `--ascii` | Emit terminal-friendly ASCII pipeline tech-tree (default if no mode flag is passed). |
| `--serve` | Start read-only `127.0.0.1` HTTP + SSE live viewer with debounced `fs.watch`. |
| `--port <num>` | Preferred port for `--serve` (default `4173`; automatically falls back to a free port if busy). |
| `--no-open` | Skip auto-opening the system browser when starting `--serve`. |

## Handoff

Summarize the current pipeline state, highlight any blocking review failures, invalid `<system_state>` blocks, or stale upstream-to-downstream blast radius, list the exact next unlocked prompt(s), and pause for the user's decision.
