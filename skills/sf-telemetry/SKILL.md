---
name: sf-telemetry
description: >-
  On-demand Agile Sizing & Token/Cost Telemetry for Software Factory. Validates Fibonacci estimates (1–8 with mandatory 8-pt split gate), logs model/token/cost/rework records out-of-repo, imports Linear comments or agent transcripts, and runs calibration/blowup reports. Use for sizing or cost calibration. Do NOT use for tech-trees (sf-tree), authoring stages, or sf-review.
---

# Agile Sizing & Token/Cost Telemetry (`sf-telemetry`)

**Persona:** Delivery Calibration & Cost Analyst

Pair disciplined Fibonacci agile sizing (`1, 2, 3, 5, 8`) with LLM model, non-overlapping token bucket, dollar cost, and rework telemetry (`schema_version: "2.0"`) so teams can calibrate estimates against actual agentic spend and detect scope or token blowups early—without always-on hooks, background daemons, or consumer repo pollution.

## Guardrails (Non-Negotiable)

- **Zero Idle Token Overhead:** Strictly on-demand skill (`0` always-on rules, `0` hooks, `0` MCP servers; router-only metadata). Never install background hooks or commit telemetry logs into consumer repositories.
- **Out-of-Repo Hashed Storage Default:** Telemetry JSONL logs live outside the repository working tree under `~/.config/software-factory/telemetry/<workspace-slug>-<sha256-8>.jsonl` (private directory `0o700`, file mode `0o600`, advisory lockfile + atomic upsert; overridable via `--store <path>` or `SF_TELEMETRY_STORE`). Explicit store paths inside the workspace, git root, or traversing symlinks are rejected.
- **8-Point Epic Split Gate:** Any issue estimated at `8` points carries high token-variance risk and MUST be decomposed into scoped `1`–`5` point issues before moving to `In Progress`.
- **Zero External Dependencies:** All scripts under `<skill_dir>/scripts/` (`cli.mjs`, `schema.mjs`, `pricing.mjs`, `parsers.mjs`, `calibrator.mjs`) and shared `lib/` helpers run exclusively on Node.js 22+ stdlib.
- **Prompt Quality Gate (Context-Aware):** Evaluate before invoking `scripts/cli.mjs` (exempt follow-up refinements to an active telemetry command):
  - *High-Signal Check:* Pass silently when the requested workflow (`size-check`, `log`, `format-comment`, `import-bootstrap`, `import-transcript`, or `report`) and its required inputs (estimate, issue ID/felt size, or import source path) are clear from prompt or conversation context. Pause on vague prompts (e.g., *"Check telemetry"* or *"Size this"*) missing workflow or target inputs.
  - *Anti-Patterns:* Asking to install always-on hooks, commit telemetry logs into the consumer repo, or skip splitting an `8`-point epic (all non-overridable).
  - *When Weak/Ambiguous:* Pause in 1 turn and show: (1) 1–3 brief gap/anti-pattern bullets, (2) a suggested High-Signal Prompt pre-filled with known context and explicit `[placeholders]` for unknowns, (3) 2–4 targeted follow-up questions, and (4) three options: answer to tailor & run, edit/accept the prompt, or reply `"proceed anyway"` to override.
  - *Override & Upfront Bypass:* Soft workflow/format ambiguities are overridable via `"proceed anyway"`, `"use defaults"`, or `"skip prompt check"` (list assumed flags/defaults under **Assumptions Used** in chat). Zero-idle-overhead, out-of-repo storage, and the `8`-Point Epic Split Gate are never overridable.

## Fibonacci Sizing Rubric

| Points | Scope & Risk Profile | Action |
| :---: | :--- | :--- |
| **1** | Trivial, single-file tweak or copy update; zero design ambiguity. | Ready to execute |
| **2** | Small, scoped change across 1–3 files; straightforward verification. | Ready to execute |
| **3** | Medium; multi-file change, single skill update, or focused design spec. | Ready to execute |
| **5** | Large; new skill, integration, or cross-pipeline change with meaningful validation. | Ready to execute |
| **8** | Epic / high token-variance risk. | **MUST split into 1–5 pt issues first** |

## Record Schema (`schema_version: "2.0"`)

Each JSONL line stores a normalized v2 record with non-overlapping token buckets (`uncached_input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`), `cost_usd`, `estimate_points`, `felt_points`, `execution` (`smooth` / `minor_rework` / `major_rework` / `blocked`; `first-pass` aliases to `smooth`), `rework_count`, `review_verdict` (`PASS` / `FAIL`), `source` (`manual` / `linear_bootstrap` / `transcript`), `source_ref` (stable idempotent upsert key), and optional `model_breakdown` (per-model bucket breakdown for multi-model transcripts).

## Operating Workflows

Resolve `<skill_dir>` to the directory containing this `SKILL.md` (where `scripts/cli.mjs` resides).

### 1. Validate Issue Sizing (`size-check` / `size`)

Before starting implementation, validate the Fibonacci estimate and enforce the `8`-point split gate:

```bash
node <skill_dir>/scripts/cli.mjs size-check --estimate 5 --json
```

*(Alias: `size`. Exits with code `2` and `status: "SPLIT_REQUIRED"` when `--estimate 8`.)*

### 2. Record Closing Telemetry & Format Linear Comment (`log` / `format-comment`)

When closing an issue, log a v2 record to the hashed out-of-repo JSONL store (USD cost is auto-estimated via the built-in offline pricing table when tokens are provided and `--cost-usd` is omitted) and emit the canonical Linear closing comment:

```bash
node <skill_dir>/scripts/cli.mjs log \
  --dir <workspace_root> \
  --issue SOF-26 \
  --project P-SOF-6 \
  --phase architecture \
  --model "Gemini 4 Neon (High)" \
  --estimate 5 --felt 3 \
  --uncached-input-tokens 45000 --cache-read-tokens 40000 --cache-write-tokens 0 --output-tokens 14000 \
  --execution smooth --review-verdict PASS \
  --source-ref "linear-issue:SOF-26" \
  --notes "Zero-dep analyzer passed unit tests on first run."

node <skill_dir>/scripts/cli.mjs format-comment \
  --issue SOF-26 --model "Gemini 4 Neon (High)" \
  --estimate 5 --felt 3 --execution smooth \
  --notes "Zero-dep analyzer passed unit tests on first run."
```

### 3. Import Historical Bootstrap Comments or Agent Transcripts

- **From Linear MCP Bootstrap Comments (`import-bootstrap`):** Export Linear issue comments containing `### Telemetry (Track #4 Bootstrap)` blocks into a scratch JSON/Markdown file and ingest them (idempotent upsert via `source_ref`):
  ```bash
  node <skill_dir>/scripts/cli.mjs import-bootstrap --dir <workspace_root> --input <scratch>/linear-comments.json
  ```
- **From Local Agent JSONL Transcripts (`import-transcript`):** Stream-parse model and non-overlapping token usage (including `model_breakdown` for multi-model runs) from Antigravity `transcript.jsonl`, Claude Code, or Gemini CLI JSONL logs:
  ```bash
  node <skill_dir>/scripts/cli.mjs import-transcript --dir <workspace_root> --input <path/to/transcript.jsonl> --issue SOF-26 --estimate 5 --felt 3
  ```

### 4. Generate Calibration & Blowup Reports (`report`)

Aggregate Fibonacci buckets (`1, 2, 3, 5, 8`), calibration ratios (`felt / estimate`), exact & ±1 Fibonacci accuracy, per-model smoothness, `$/pt` baselines, and scope/token blowup alerts (`unsplit_epic_8pt`, `scope_blowup`, `high_rework`, `cost_outlier`):

```bash
node <skill_dir>/scripts/cli.mjs report --dir <workspace_root> --markdown
node <skill_dir>/scripts/cli.mjs report --dir <workspace_root> --ascii --project P-SOF-6 --since 2026-01-01
node <skill_dir>/scripts/cli.mjs report --dir <workspace_root> --json --pricing <custom-rates.json>
```

### 5. CLI Options Reference (`scripts/cli.mjs`)

| Flag | Description |
| :--- | :--- |
| `--dir <path>` | Consumer workspace root (computes `<slug>-<sha256-8>.jsonl` default store path). |
| `--store <path>` | Explicit out-of-repo `.jsonl` store path (overrides default & `SF_TELEMETRY_STORE`). |
| `--pricing <path>` | Custom model pricing JSON override (also honors `SF_TELEMETRY_PRICING`; reprices token records in `report`). |
| `--input <file>` | Input JSON/Markdown/JSONL file for `import-bootstrap` or `import-transcript`. |
| `--issue <id>` / `--project <id>` / `--phase <name>` / `--model <name>` | Record fields (on `log`/imports) or report filters (on `report`). |
| `--since <iso-date>` | Filter `report` records recorded on or after an ISO-8601 date/timestamp. |
| `--estimate <1\|2\|3\|5\|8>` / `--felt <1\|2\|3\|5\|8>` | Estimated and actual felt Fibonacci size (`felt` defaults to `estimate`). |
| `--uncached-input-tokens <n>` / `--cache-read-tokens <n>` / `--cache-write-tokens <n>` / `--output-tokens <n>` | Non-overlapping token counts for v2 cost estimation and reporting. |
| `--cost-usd <n>` | Explicit USD cost (e.g., `"$1.25"`); auto-estimated when omitted and tokens are present. |
| `--execution <mode>` / `--rework-count <n>` / `--review-verdict <PASS\|FAIL>` | Execution outcome (`smooth`, `first-pass`, `minor_rework`, `major_rework`, `blocked`), integer rework cycles, and review verdict. |
| `--notes <text>` / `--source-ref <ref>` | One-line takeaway and stable source reference for idempotent upsert. |
| `--dry-run` / `--strict` | Parse/validate without writing (`--dry-run`); fail `report` on corrupt JSONL lines (`--strict`). |
| `--json` / `--markdown` / `--ascii` | Output format for `report`, `size-check`, `log`, and imports. |

### 6. Cross-Harness No-Node 22+ Fallback

If Node.js 22+ is unavailable, apply the Fibonacci rubric manually, enforce splitting `8`-point issues, and emit the canonical closing telemetry block directly:

```markdown
### Telemetry (Track #4 Bootstrap)
- **Model:** <human-readable model name>
- **Estimate vs. Felt Size:** <est> pts -> <felt> pts
- **Tokens / Cost:** <actual if known, else n/a>
- **Execution:** <smooth | minor rework | major rework> — <1-line cause/takeaway>
```

## Handoff

Present the sizing check, logged record, or calibration report (highlighting any `8`-pt split gates, underestimation blowups, high rework, or cost outliers), and pause for the user's decision.
