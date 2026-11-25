---
name: sf-mockery
description: >-
  Optional Stage 6b of the Software Factory pipeline. Builds interactive Mockery flow-canvas mockups under docs/factory/mockups/ plus an 80/20 manifest at docs/factory/06b-mockery.md. Supports styled mode after sf-ui and wireframe mode after sf-ux. Do NOT use for UX wireframes (sf-ux), UI design tokens (sf-ui), or production frontend code.
---

# Interactive Prototype & Mockery Canvas Builder

**Persona:** Design Technologist / Interactive Prototyper

Translate validated UX flows and UI design tokens into a clickable Mockery flow canvas (`docs/factory/mockups/`) paired with an 80/20 manifest (`docs/factory/06b-mockery.md`)—100% optional, file-native, and free of production application code.

## Inputs & Handoff Gate

- **Operating Modes:**
  - **Styled Mode (default when `06-ui.md` exists):** Require `sf-vision` (`project_name`, `primary_user`, `ux_tone`, `hard_constraints`, `explicitly_out_of_scope`), `sf-ux` (`screens_required`, `primary_navigation_pattern`, `key_interactions`, `accessibility_requirements`), and `sf-ui` (`css_framework_recommendation`, `color_palette`, `typography`, `border_radius_base`). Emit `"fidelity": "styled"`, `"tokens_synced_from_ui": true`. Inherit optional `sf-prd` (`04-prd.md`: `core_flows`, `edge_case_mitigations`) and `sf-brd` (`03-brd.md`: `compliance_requirements`, `budget_or_timeline_constraints`) when present.
  - **Wireframe Mode (when `06-ui.md` is absent, post-`sf-ux`):** Require `sf-vision` and `sf-ux` (plus optional `04-prd.md` / `03-brd.md` when present). Emit neutral grayscale tokens (`"fidelity": "wireframe"`, `"tokens_synced_from_ui": false`). After `sf-ui` runs later, re-invoking `sf-mockery` restyles `tokens.css` and `kit.css` in place (`"fidelity": "styled"`, `"tokens_synced_from_ui": true`).
- **Input Resolution Order:** Resolve upstream `<system_state>` blocks in order before the Missing-Input Guard: (1) explicit prompt files/text, (2) earlier conversation turns, (3) canonical workspace files `docs/factory/01-vision.md`, `docs/factory/05-ux.md`, `docs/factory/06-ui.md` (required in styled mode, absent in wireframe mode), plus optional `04-prd.md`, `03-brd.md`, and existing `06b-mockery.md` / `docs/factory/mockups/`.
- **Missing-Input Guard:**
  - If `sf-vision` or `sf-ux` `<system_state>` is missing or invalid JSON, **STOP** and ask the user to provide it (or offer to run the missing upstream skill first).
  - If `docs/factory/06-ui.md` has invalid JSON, or the user explicitly requested **Styled Mode** while `06-ui.md` is absent, **STOP** and ask to fix/run `sf-ui` first (or switch to wireframe mode).
  - If `06-ui.md` is absent and fidelity mode is unspecified, pause via the Prompt Quality Gate so the user chooses **Wireframe Mode** (`tokens_synced_from_ui: false`) now or running `sf-ui` first. Never invent screens, flows, or visual brand tokens.
- **Strict Constraint Inheritance:** Strictly honor `sf-vision` `hard_constraints` and `explicitly_out_of_scope`, `sf-ux` `accessibility_requirements`, and optional `sf-brd` (`03-brd.md`) `compliance_requirements` and `budget_or_timeline_constraints` when present.
- **Stage Boundaries & Gates:** Write only static canvas files under `docs/factory/mockups/` and `docs/factory/06b-mockery.md`. Do **NOT** write `CLAUDE.md` inside `docs/factory/mockups/` (keeps zero always-on rules/hooks overhead in consumer repos), write production code, mutate upstream docs, or invent screens outside `sf-ux`.
- **Prompt Quality Gate (Context-Aware):** Run after resolving upstream `<system_state>` (exempt granular edits to existing `docs/factory/mockups/` or `sf-review` fixes):
  - *High-Signal Check:* Pass silently when fidelity mode (`styled` with valid `06-ui.md`, or explicit `wireframe` without `06-ui.md`) and device preset(s) (`phone`/`tablet`/`pos`/`desktop`) are clear. Pause if fidelity mode (when `06-ui.md` is absent) or device preset(s) are ambiguous.
  - *Anti-Patterns:* **Multi-stage bundling** (non-overridable; offer `sf-mockery` alone first), requesting production code/`<script>` interactivity, or inventing screens outside `sf-ux`.
  - *When Weak/Ambiguous:* Pause in 1 turn with: (1) 1–3 gap bullets, (2) a suggested High-Signal Prompt with known context + `[placeholders]`, (3) 2–4 targeted follow-up questions, and (4) options to answer & run, edit/accept prompt, or reply `"proceed anyway"`.
  - *Override & Upfront Bypass:* Soft gaps (device preset choice or wireframe-mode confirmation when `06-ui.md` is absent) are overridable via `"proceed anyway"`, `"use defaults"`, or `"skip prompt check"` (list defaults under **Assumptions Used** in chat without altering headings or `<system_state>`). Missing-Input Guard and multi-stage bundling are never overridable.

## Mockery Canvas Authoring Rules

Project files live under `docs/factory/mockups/` (`flow.json`, `tokens.css`, `kit.css`, optional `fonts.css`/`assets/`, `components/<name>.html`, `screens/<id>.html`).

> Read [references/mockery-reference.md](references/mockery-reference.md) for the complete CSS token catalog, device preset dimensions, deterministic grid coordinates, edge styling rules, and `<x-include>` partial syntax.

Core invariants enforced by `scripts/cli.mjs check`:
- **Static Shadow-Root Screens:** Each `screens/<id>.html` has one `<div class="screen">` sized to its node's `w`×`h`. **Forbidden:** `<script>`, `@media`, viewport units (`vw`/`vh`/`vmin`/`vmax`/`dvh`/`svh`/`lvh`), and `position: fixed`.
- **Token-Only CSS:** Define variables only inside `:host { ... }` in `tokens.css` (mapped verbatim from `sf-ui` in styled mode; neutral grayscale in wireframe mode) and consume via `var(--...)` in `kit.css` (`@layer shared`).
- **Interactive Wiring & Partials:** Wire transitions with `data-goto="<target-id>"` + `flow.json` `edges`; extract markup shared across 2+ screens into `components/<name>.html` (`.c-<name>`, invoked via `<x-include>`, zero `<style>` tags in partials).
- **Granular Edits:** On feedback, edit only the smallest affected file and keep `docs/factory/06b-mockery.md` synchronized.

## Execution Steps

Resolve `<skill_dir>` to this skill's directory (hosting the zero-dep Node 22+ CLI `scripts/cli.mjs`).

1. **Validate Inputs & Mode:** Parse upstream `<system_state>` blocks (stopping on missing/invalid inputs), lock inherited constraints, and confirm **Styled Mode** (`06-ui.md` present, `tokens_synced_from_ui: true`), **Wireframe Mode** (without `06-ui.md`, `tokens_synced_from_ui: false`), or an in-place restyle/update.
2. **Plan Canvas:** Map every `sf-ux` screen, `primary_navigation_pattern`, `key_interactions`, and critical `empty`/`loading`/`error` state to device-sized nodes, sections, edges, and shared components (per `references/mockery-reference.md`).
3. **Write Canvas Files:** Write `tokens.css`, `kit.css`, `components/*.html`, `screens/*.html`, and `flow.json` under `docs/factory/mockups/` (never writing `CLAUDE.md`).
4. **Validate:** Run `node <skill_dir>/scripts/cli.mjs check docs/factory/mockups --json` and fix all errors before returning (or verify statically if Node 22+ is unavailable).
5. **Write Manifest & Pause:** Emit `docs/factory/06b-mockery.md`, surface viewer/export commands, and pause for human review.

## Output Format (80/20 Hybrid Artifact)

Produce **80% narrative** and **20% strict state** at `docs/factory/06b-mockery.md` using these exact Markdown headings in order:

### 1. Canvas & Flow Overview
Fidelity mode (`wireframe` or `styled`), target device(s), section grouping, happy-path flow, and state-variant coverage (`empty`, `loading`, `error`).

### 2. Screen & Component Inventory
Mapping of each Mockery node `id`, `file`, `device`, `variant`, and `sf-ux` screen reference, plus shared `<x-include>` components and key edges.

### 3. Token Mapping & Viewer Commands
How `tokens.css` maps `sf-ui` tokens (or neutral wireframe palette), check results, and local viewer/export commands.

Place strict, valid JSON directly inside `<system_state>...</system_state>` (no markdown code fences, comments, or trailing commas).

<system_state>
{
  "phase": "mockery",
  "fidelity": "wireframe | styled",
  "mockups_dir": "docs/factory/mockups",
  "devices": [],
  "sections": [],
  "screens": [
    {
      "id": "",
      "title": "",
      "file": "",
      "device": "",
      "ux_screen_ref": "",
      "variant": "happy | empty | loading | error"
    }
  ],
  "components": [],
  "edges_count": 0,
  "tokens_synced_from_ui": false
}
</system_state>

## Validation, Viewer Launch & Next Step

Before returning, verify:
1. **Valid Strict JSON & Parity:** `<system_state>` has `"phase": "mockery"`, `"tokens_synced_from_ui": true` in `styled` mode (`false` in `wireframe` mode), and 1:1 parity with `docs/factory/mockups/flow.json` (`screens`, `sections`, `edges_count`, `components`).
2. **Integrity & Zero Leakage:** `cli.mjs check` passes with zero errors; zero forbidden constructs or `CLAUDE.md`; every `sf-ux` screen represented with zero out-of-scope or production code leakage.

- **Save Location:** Write the Mockery project to `docs/factory/mockups/` and manifest to `docs/factory/06b-mockery.md` in addition to returning the summary in chat.
- **Bundled Viewer & Offline Export (Zero External Dependencies):**
  - Live hot-reload canvas (`127.0.0.1:5180`, SSE hot reload): `node <skill_dir>/scripts/cli.mjs serve docs/factory/mockups`
  - Standalone offline `preview.html` (opens over `file://` without Node.js): `node <skill_dir>/scripts/cli.mjs export docs/factory/mockups` (or `--out <path>`)
  - Pure file-only fallback succeeds cleanly when Node 22+ is unavailable.
- **Handoff Gate:** Pause for human review and suggest running `sf-review` against upstream artifacts (`sf-vision` + `sf-ux`, plus `sf-ui` in `styled` mode) before advancing to `sf-architecture` (or `sf-ui` if in `wireframe` mode). Never auto-advance.
