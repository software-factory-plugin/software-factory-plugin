---
name: sf-telemetry
description: >-
  On-demand Agile Sizing & Token/Cost Telemetry skill for Software Factory. Validates Fibonacci estimates (1, 2, 3, 5, 8 with mandatory split gate on 8-pt epics), logs model/token/cost/rework records to an out-of-repo JSONL store, imports Linear closing telemetry comments and local agent transcript JSONL usage, formats canonical Linear Telemetry comments, and generates Fibonacci calibration and scope/cost blowup reports (--json, --markdown, --ascii). Use when sizing issues, capturing closing telemetry, importing bootstrap telemetry from Linear or transcripts, or calibrating cost-per-point curves. Do NOT use for DAG/tech-tree visualization (sf-tree), authoring pipeline stages (sf-vision..sf-specs), or Red Team audits (sf-review).
---

# Agile Sizing & Token/Cost Telemetry (`sf-telemetry`)

**Persona:** Delivery Calibration & Cost Analyst

Pair disciplined Fibonacci agile sizing (`1, 2, 3, 5, 8`) with LLM model, token, dollar cost, and rework telemetry so teams can calibrate estimates against actual agentic spend and detect scope or token blowups early—without always-on hooks, background daemons, or consumer repo pollution.

## Guardrails (Non-Negotiable)

- **Zero Idle Token Overhead:** Strictly on-demand skill (`0` rules, `0` hooks, `0` mcpServers). Never install background hooks or commit telemetry logs into consumer repositories.
- **Out-of-Repo Storage Default:** Telemetry JSONL logs live outside the repository working tree under `~/.config/software-factory/telemetry/<workspace-slug>.jsonl` (overridable via `--store <path>` or `SF_TELEMETRY_STORE`).
- **8-Point Epic Split Gate:** Any issue estimated at `8` points carries high token-variance risk and MUST be decomposed into scoped `1`–`5` point issues before moving to `In Progress`.
- **Zero External Dependencies:** All scripts under `<skill_dir>/scripts/` (`cli.mjs`, `schema.mjs`, `pricing.mjs`, `parsers.mjs`, `calibrator.mjs`) run exclusively on Node.js 20+ stdlib.

## Fibonacci Sizing Rubric

| Points | Scope & Risk Profile | Action |
| :---: | :--- | :--- |
| **1** | Trivial, single-file tweak or copy update; zero design ambiguity. | Ready to execute |
| **2** | Small, scoped change across 1–3 files; straightforward verification. | Ready to execute |
| **3** | Medium; multi-file change, single skill update, or focused design spec. | Ready to execute |
| **5** | Large; new skill, integration, or cross-pipeline change with meaningful validation. | Ready to execute |
| **8** | Epic / high token-variance risk. | **MUST split into 1–5 pt issues first** |

## Operating Workflows

Resolve `<skill_dir>` to the directory containing this `SKILL.md` (where `scripts/cli.mjs` resides).

### 1. Validate Issue Sizing (`size-check`)

Before starting implementation, validate the Fibonacci estimate and enforce the `8`-point split gate:

```bash
node <skill_dir>/scripts/cli.mjs size-check --estimate 5 --json
```

*(Exits with code `2` and `status: "SPLIT_REQUIRED"` when `--estimate 8`.)*

### 2. Record Closing Telemetry & Format Linear Comment (`log` / `format-comment`)

When closing an issue, log the record to the out-of-repo JSONL store (cost is automatically estimated via the built-in offline pricing table when tokens are provided and `--cost-usd` is omitted) and emit the canonical Linear closing comment:

```bash
node <skill_dir>/scripts/cli.mjs log \
  --dir <workspace_root> \
  --issue SOF-26 \
  --project P-SOF-6 \
  --model "Gemini 4 Neon (High)" \
  --estimate 5 --felt 3 \
  --input-tokens 85000 --output-tokens 14000 \
  --execution smooth \
  --notes "Zero-dep analyzer passed unit tests on first run."

node <skill_dir>/scripts/cli.mjs format-comment \
  --issue SOF-26 --model "Gemini 4 Neon (High)" \
  --estimate 5 --felt 3 --execution smooth \
  --notes "Zero-dep analyzer passed unit tests on first run."
```

### 3. Import Historical Bootstrap Comments or Agent Transcripts

- **From Linear MCP Bootstrap Comments (`import-bootstrap`):** Export Linear issue comments containing `### Telemetry (Track #4 Bootstrap)` blocks into a scratch JSON file and ingest them (deduplicated automatically):
  ```bash
  node <skill_dir>/scripts/cli.mjs import-bootstrap --dir <workspace_root> --input <scratch>/linear-comments.json
  ```
- **From Local Agent JSONL Transcripts (`import-transcript`):** Extract model and token usage from Antigravity `transcript.jsonl`, Claude Code, or Gemini CLI JSONL logs (gracefully records `null` if token fields are unavailable):
  ```bash
  node <skill_dir>/scripts/cli.mjs import-transcript --dir <workspace_root> --input <path/to/transcript.jsonl> --issue SOF-26 --estimate 5 --felt 3
  ```

### 4. Generate Calibration & Blowup Reports (`report`)

Aggregate Fibonacci buckets (`1, 2, 3, 5, 8`), calibration ratios (`felt / estimate`), exact & ±1 Fibonacci accuracy, per-model smoothness, `$/pt` baselines, and scope/token blowup alerts (`unsplit_epic_8pt`, `scope_blowup`, `high_rework`, `cost_outlier`):

```bash
node <skill_dir>/scripts/cli.mjs report --dir <workspace_root> --markdown
node <skill_dir>/scripts/cli.mjs report --dir <workspace_root> --ascii
node <skill_dir>/scripts/cli.mjs report --dir <workspace_root> --json
```

*(Pass `--pricing <custom-rates.json>` to override built-in reference USD/1M token rates.)*

### 5. Cross-Harness No-Node 20+ Fallback

If Node.js 20+ is unavailable, apply the Fibonacci rubric manually, enforce splitting `8`-point issues, and emit the canonical closing telemetry block directly:

```markdown
### Telemetry (Track #4 Bootstrap)
- **Model:** <human-readable model name>
- **Estimate vs. Felt Size:** <est> pts -> <felt> pts
- **Tokens / Cost:** <actual if known, else n/a>
- **Execution:** <smooth | minor rework | major rework> — <1-line cause/takeaway>
```

## Handoff

Present the sizing check, logged record, or calibration report (highlighting any `8`-pt split gates, underestimation blowups, high rework, or cost outliers), and pause for the user's decision.
