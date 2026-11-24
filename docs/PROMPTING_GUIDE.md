# Software Factory — Operator Prompting Guide

A practical handbook for running the 12 **Software Factory** skills (`sf-vision` through `sf-specs`, `sf-mockery`, `sf-review`, `sf-tree`, and `sf-telemetry`) across **Antigravity**, **Claude Code**, and **Gemini CLI**.

> **Zero Idle Token Overhead:** This handbook lives under `docs/` for human operators and is never loaded into the agent's idle router context.

---

## 1. The Golden Operating Loop

Every Software Factory project follows a simple, human-validated cadence:

1. **Generate one stage at a time** (writing canonical 80/20 artifacts under `docs/factory/01-vision.md`–`08-specs.md` in your *consumer* repository).
2. **Audit before advancing** with `sf-review` whenever constraints, monetization, UX, or architecture shift.
3. **Inspect progress & staleness** at any time with `sf-tree` (both `docs/factory/` pipeline stages and Linear work-item dependency tech-trees).
4. **Size & calibrate delivery** during implementation using `sf-telemetry` (Fibonacci `1, 2, 3, 5, 8`, splitting any `8`-pt epic before starting).

---

## 2. High-Signal vs. Anti-Pattern Prompts

| Pattern | Weak Prompt (Causes Drift) | High-Signal Prompt (Tight & Deterministic) |
| :--- | :--- | :--- |
| **Starting a project** | *"Build me a status page app."* | *"Use `sf-vision` to charter PulseBoard: a self-hosted uptime & status dashboard for 2–15 dev SaaS teams. Hard constraints: zero third-party trackers, single-container Node 20+ + PostgreSQL, < 5 min setup. Explicitly out of scope: on-call paging, SMS billing, SAML SSO."* |
| **Advancing stages** | *"Now do BRD, PRD, UX, and Architecture all at once."* | *"Using `docs/factory/01-vision.md` and `docs/factory/02-market-research.md`, run `sf-brd` to define open-core monetization, KPIs, and compliance constraints, then stop for review."* |
| **Red Team auditing** | *"Does my architecture look okay?"* | *"Run `sf-review` comparing upstream `01-vision.md` and `04-prd.md` against `07-architecture.md`. Flag any out-of-scope features, missing flows, or `<system_state>` drift."* |
| **Visualizing work** | *"What should I work on?"* | *"Use `sf-tree` in Work Tech-Tree mode for Linear team `SOF`: show ready/unlocked tickets, blockers, and the estimate-weighted remaining Critical Path, then launch `--serve`."* |

### Built-In Prompt Quality Gate (All 12 Skills)

You do **not** have to memorize every high-signal template above. Every Software Factory skill includes a context-aware, behind-the-scenes **Prompt Quality Gate** (zero idle token overhead; identical across Antigravity, Claude Code, Codex, and Gemini CLI):

- **Silent When Clear:** Downstream skills resolve `docs/factory/` upstream `<system_state>` blocks first. Concise prompts like *"Run `sf-prd`"* pass silently when upstream files already make execution unambiguous. Targeted revisions to an existing artifact or `sf-review` blocking-issue fixes also bypass the gate automatically.
- **1-Turn Coaching When Weak or Ambiguous:** If your prompt plus resolved upstream state still leaves stage-critical ambiguities (e.g., a one-line `sf-vision` idea with no user/constraints/exclusions, an `sf-brd` prompt with no monetization or budget hints, or a vague `sf-review` / `sf-tree` scope), the skill pauses before generating and shows:
  1. **Gap / Anti-Pattern Diagnosis** (1–3 concise bullets),
  2. **Suggested High-Signal Prompt** pre-filled with known context and explicit `[placeholders]` for unknowns (never silently inventing assumptions),
  3. **2–4 Targeted Follow-Up Questions** covering only those `[placeholders]`, and
  4. **Three Ways to Continue:** answer the questions to tailor & run, edit/accept the suggested prompt, or reply `"proceed anyway"` to override.
- **Soft Overrides & Upfront Bypass:** For soft ambiguities, you can reply `"proceed anyway"`—or pass `"use defaults"` / `"skip prompt check"` upfront on turn 1. The skill runs and lists any inferred defaults under a brief **Assumptions Used** note in chat without altering the saved artifact's strict headings or `<system_state>` schema.
- **Non-Overridable Hard Invariants:** Missing-Input Guards, **multi-stage bundling** (asking to run multiple pipeline stages at once—the skill offers to run only the single next stage), `sf-review`'s no-rewrite rule, `sf-tree`'s read-only guard, and `sf-telemetry`'s 8-point epic split gate cannot be overridden.

---

## 3. Copy-Paste Starter Prompts (All 12 Skills)

### Stage 1 — `sf-vision` (`docs/factory/01-vision.md`)
> *"Run `sf-vision` for `<Project Name>`. Primary user: `<who>`. UX tone: `<e.g., minimalist, high-contrast, utilitarian>`. Hard constraints: `<budget, stack, latency, privacy rules>`. Explicitly out of scope for v1: `<list 3+ exclusions>`."*

### Stage 2 — `sf-market-research` (`docs/factory/02-market-research.md`)
> *"Run `sf-market-research` against `docs/factory/01-vision.md`. Benchmark 3–5 real competitors, pricing models, and macro risks, and state clearly whether our market gap is Validated or Pivot Required."*

### Stage 3 — `sf-brd` (`docs/factory/03-brd.md`)
> *"Run `sf-brd` using `01-vision.md` and `02-market-research.md`. Define monetization tiers, 3 measurable KPIs, compliance constraints, and our 6-week MVP budget/timeline."*

### Stage 4 — `sf-prd` (`docs/factory/04-prd.md`)
> *"Run `sf-prd` using `01-vision.md` and `03-brd.md`. Detail core user flows, applied business rules, required integrations, and at least 3 critical failure edge cases with deterministic fallbacks. Do not pick UI layouts or databases."*

### Stage 5 — `sf-ux` (`docs/factory/05-ux.md`)
> *"Run `sf-ux` using `01-vision.md` and `04-prd.md`. Map every core flow and error state into screens, navigation hierarchy, ASCII structural wireframes, key interactions, and WCAG 2.1 AA accessibility requirements."*

### Stage 6 — `sf-ui` (`docs/factory/06-ui.md`)
> *"Run `sf-ui` using `01-vision.md` and `05-ux.md`. Define the CSS framework recommendation, semantic color palette, typography scale, and base border radius aligned with our `ux_tone`."*

### Stage 6b (Optional) — `sf-mockery` (`docs/factory/06b-mockery.md` + `docs/factory/mockups/`)
- **Styled Mode (after `sf-ui`):**
  > *"Run `sf-mockery` in styled mode using `01-vision.md`, `05-ux.md`, and `06-ui.md` to generate a clickable flow canvas under `docs/factory/mockups/` synced to our UI tokens, validate it with the bundled checker, and offer to serve or export a standalone `preview.html`."*
- **Wireframe Mode (after `sf-ux`, before `sf-ui`):**
  > *"Run `sf-mockery` in wireframe mode from `05-ux.md` so we can click through flows before choosing colors and fonts."*
- **Standalone Offline Export (Zero-Runtime Stakeholder Share):**
  > *"Export `docs/factory/mockups/` to a single standalone `preview.html` using `sf-mockery`'s bundled exporter so stakeholders can open and click through it without a local server."*

### Stage 7 — `sf-architecture` (`docs/factory/07-architecture.md`)
> *"Run `sf-architecture` using `01-vision.md`, `03-brd.md`, `04-prd.md`, `05-ux.md`, and `06-ui.md` (plus `06b-mockery.md` if present). Select the exact frontend/backend stack, database schema, data models, and core API endpoints."*

### Stage 8 — `sf-specs` (`docs/factory/08-specs.md`)
> *"Run `sf-specs` using `01-vision.md`, `04-prd.md`, and `07-architecture.md`. Generate strict OpenAPI stubs, unit test specs, E2E journeys, and static linter/security rules before any production code is written."*

### Universal Gate — `sf-review` (`docs/factory/reviews/<source>-vs-<target>-review.md`)
> *"Run `sf-review` auditing `docs/factory/07-architecture.md` against `docs/factory/01-vision.md` and `docs/factory/04-prd.md`. Do not rewrite the target; return a strict PASS/FAIL audit log."*

### Live Navigator — `sf-tree` (Read-Only)
- **Pipeline Stages:**
  > *"Run `sf-tree` on this repo to show pipeline completion, `<system_state>` validity, stale blast radius, and the next unlocked stage."*
- **Work Tech-Tree (Linear / Tickets):**
  > *"Use `sf-tree` in Work Tech-Tree mode for Linear project `<P-ID>`: export the snapshot to scratch (never the repo tree), show ready tickets and remaining Critical Path, and launch `--serve`."*

### Delivery Calibration — `sf-telemetry` (On-Demand)
- **Pre-implementation Sizing Gate:**
  > *"Use `sf-telemetry` `size-check` on our upcoming issues and split any 8-point epics into 1–5 point tasks."*
- **Calibration Report:**
  > *"Use `sf-telemetry` to import our Linear closing telemetry comments from scratch and generate a Markdown Fibonacci calibration & blowup report."*

---

## 4. Recovery Playbooks

### Missing-Input Guard Triggered
Downstream skills **STOP** intentionally when an upstream `<system_state>` block is missing or malformed JSON.
- **Fix:** Either point the agent to the upstream file (`docs/factory/01-vision.md`), paste the upstream `<system_state>` block, or run the missing upstream skill first. Never tell the agent to "just guess."

### `sf-review` Returns `FAIL`
1. Read `blocking_issues` in the review's `<system_state>`.
2. Re-run *only* the target stage skill with those exact blocking issues as revision instructions.
3. Re-run `sf-review` so the review file timestamp is newer than the revised target (clearing `is_stale: true` in `sf-tree`).

### Upstream Change Creates Stale Blast Radius
When you revise an early artifact (e.g., `01-vision.md`), `sf-tree` automatically flags all downstream dependents as `STALE`.
1. Open `sf-tree --serve` and toggle **Highlight Stale Blast Radius**.
2. Walk left-to-right across highlighted nodes using the 1-click **Copy Prompt** button to reconcile each downstream artifact in topological order.

### 8-Point Epic / Token Blowup Alert
When `sf-telemetry` flags `SPLIT_REQUIRED` (`8 pts`) or `scope_blowup` (`felt / est >= 1.6x`):
1. Decompose the epic along vertical seams (e.g., data contract/analyzer → adapter/server → UI → docs/validation) into `2`–`5` pt issues with explicit `blocks`/`blockedBy` edges.
2. Verify the new dependency chain in `sf-tree` Work Tech-Tree mode before starting.

---

## 5. Cross-Harness Tips

- **Antigravity:** Supports all 12 skills natively via `plugin.json`, inline `sf-tree` snapshots, and opening `http://127.0.0.1:4173` directly in the built-in browser pane.
- **Claude Code:** Loads `.claude-plugin/plugin.json` + `skills/`. Run `sf-tree` and `sf-telemetry` scripts directly with Node.js 20+ (`--ascii`, `--mermaid`, `--json`, or `--serve`).
- **Gemini CLI:** Links via `gemini-extension.json` (`gemini extensions link .`). Identical CLI behavior across all bundled Node.js 20+ scripts, with graceful pure-markdown fallback whenever Node 20+ is absent.

---

## 6. Running the Automated Eval Suite

Contributors and operators can verify all 12 skills, golden PulseBoard `<system_state>` fixtures, Missing-Input Guards, `sf-review` vectors, and idle-router token budgets offline with zero npm dependencies:

```bash
node evals/run.mjs --ascii
node evals/run.mjs --markdown
node evals/run.mjs --json
```
