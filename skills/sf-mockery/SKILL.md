---
name: sf-mockery
description: >-
  Optional Stage 6b of the Software Factory pipeline. Generates and updates interactive, clickable Mockery flow-canvas mockups (flow.json, static HTML screens, reusable partials, and token-driven CSS) under docs/factory/mockups/ plus an 80/20 manifest at docs/factory/06b-mockery.md. Supports styled mode after sf-ui (default) and wireframe mode after sf-ux. Do NOT use for UX IA/wireframes (sf-ux), design token selection (sf-ui), or production frontend code.
---

# Interactive Prototype & Mockery Canvas Builder

**Persona:** Design Technologist / Interactive Prototyper

Translate validated UX flows and UI design tokens into a live, clickable Mockery flow canvas (`docs/factory/mockups/`) paired with an 80/20 manifest artifact (`docs/factory/06b-mockery.md`). Give stakeholders a pannable, zoomable prototype to inspect screens, state variants, and transitions before engineering architecture begins—while staying 100% optional, file-native, and free of production application code.

## Inputs & Handoff Gate

- **Operating Modes:**
  - **Styled Mode (default, post-`sf-ui`):**
    - Required: `sf-vision` (`project_name`, `primary_user`, `ux_tone`, `hard_constraints`, `explicitly_out_of_scope`), `sf-ux` (`screens_required`, `primary_navigation_pattern`, `key_interactions`, `accessibility_requirements`), and `sf-ui` (`css_framework_recommendation`, `color_palette`, `typography`, `border_radius_base`).
    - Recommended (inherit whenever present): `sf-prd` (`core_flows`, `edge_case_mitigations`) and `sf-brd` (`compliance_requirements`, `budget_or_timeline_constraints`).
  - **Wireframe Mode (optional, post-`sf-ux`):**
    - When `docs/factory/06-ui.md` does not exist yet and the user requests wireframe-first prototyping after `sf-ux`, require `sf-vision` and `sf-ux` (plus `sf-prd` / `sf-brd` when present). Emit neutral grayscale tokens in `tokens.css` (`"fidelity": "wireframe"`, `"tokens_synced_from_ui": false`).
    - Once `sf-ui` runs, re-invoking `sf-mockery` restyles `tokens.css` and `kit.css` in place (`"fidelity": "styled"`, `"tokens_synced_from_ui": true`) so Mockery hot-reloads every screen without regenerating sound screen markup.
- **Input Resolution Order:** Locate upstream `<system_state>` blocks in order before triggering the Missing-Input Guard: (1) files or text explicitly provided in the user prompt, (2) earlier turns in the current conversation, (3) canonical workspace files `docs/factory/01-vision.md`, `docs/factory/05-ux.md`, `docs/factory/06-ui.md` (optional in wireframe mode), plus `docs/factory/04-prd.md`, `docs/factory/03-brd.md`, and existing `docs/factory/06b-mockery.md` / `docs/factory/mockups/` on iterative edits.
- **Missing-Input Guard:** If any required upstream `<system_state>` block is missing or contains invalid JSON, STOP immediately and ask the user to provide it (or offer to run the missing upstream skill first). Never invent screens, flows, or visual brand tokens.
- **Strict Constraint Inheritance:** Strictly honor upstream `hard_constraints`, `explicitly_out_of_scope`, `compliance_requirements`, `budget_or_timeline_constraints`, and `accessibility_requirements`.
- **Stage Boundaries & Gates:**
  - Generate static Mockery canvas files under `docs/factory/mockups/` and the 80/20 manifest at `docs/factory/06b-mockery.md`.
  - Do **NOT** write a `CLAUDE.md` file inside `docs/factory/mockups/` (authoring rules live in this skill to keep zero idle token overhead in consumer repos).
  - Do **NOT** write production frontend code, mutate upstream `05-ux.md`/`06-ui.md`, or invent screens/features absent from `sf-ux`.
- **Prompt Quality Gate (Context-Aware):** Run after resolving upstream `<system_state>` (exempt granular edits to existing `docs/factory/mockups/` or `sf-review` fixes):
  - *High-Signal Check:* Pass silently when fidelity mode (`styled` with `06-ui.md`, or explicit `wireframe` post-`sf-ux`) and target device preset(s) (`phone`/`tablet`/`pos`/`desktop`) are clear from prompt + upstream state. Pause if fidelity mode (when `06-ui.md` is absent) or target device preset(s) are ambiguous.
  - *Anti-Patterns:* **Multi-stage bundling** (non-overridable; offer to run `sf-mockery` alone first), requesting production code/`<script>` interactivity, or inventing screens outside `sf-ux`.
  - *When Weak/Ambiguous:* Pause in 1 turn with: (1) 1–3 gap/anti-pattern bullets, (2) a suggested High-Signal Prompt using known context + `[placeholders]` for unknowns, (3) 2–4 targeted follow-up questions, and (4) options to answer & run, edit/accept prompt, or reply `"proceed anyway"`.
  - *Override & Upfront Bypass:* Soft gaps are overridable via `"proceed anyway"`, `"use defaults"`, or `"skip prompt check"` (list inferred defaults under **Assumptions Used** in chat without altering manifest headings or `<system_state>`). Missing-Input Guard and multi-stage bundling are never overridable.

## Mockery Canvas Authoring Rules

All Mockery project files live under `docs/factory/mockups/` (`flow.json`, `tokens.css`, `kit.css`, optional `fonts.css` and `assets/`, `components/<name>.html`, `screens/<id>.html`).

- **Fixed-Size Static Screens (`screens/<id>.html`):**
  - Each screen renders inside its own Shadow Root adopting `tokens.css` + `kit.css` (`@layer shared`).
  - Structure: optional leading `<style>` block (screen-local overrides only), then one root `<div class="screen">` laid out with flex/grid at its node's exact `w`×`h` CSS pixels.
  - **Forbidden:** `<script>` tags, `@media` queries, viewport units (`vw`, `vh`, `vmin`, `vmax`, `dvh`, `svh`, `lvh`), and `position: fixed`.
- **Token-Only CSS (`tokens.css` & `kit.css`):**
  - `tokens.css` defines CSS variables only inside `:host { ... }` (`--color-bg`, `--color-surface`, `--color-surface-2`, `--color-border`, `--color-header`, `--color-on-header`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-accent-soft`, `--color-on-accent`, `--color-success`/`--color-danger`/`--color-warning` + `-soft`, `--font-sans`, `--font-mono`, `--text-xs`..`--text-3xl`, `--weight-regular`/`--weight-medium`/`--weight-bold`, `--space-1`..`--space-8`, `--radius-sm`/`--radius-md`/`--radius-lg`/`--radius-pill`, `--shadow-sm`/`--shadow-md`, `--tap-min: 48px`).
  - In **Styled Mode**, map `sf-ui` `color_palette`, `typography`, and `border_radius_base` verbatim into `tokens.css` and align `kit.css` states (default, hover, focus, active, disabled, error) to `sf-ui` component specs.
  - In **Wireframe Mode**, use neutral grayscale values only (e.g., `#f5f5f5`, `#ffffff`, `#222222`, `#666666`, `#333333`) with system sans/mono stacks—zero brand colors.
  - Use `var(--...)` everywhere in `kit.css` and screen `<style>` blocks; raw pixel values are allowed only for layout geometry (column widths, fixed frame heights). Put `@font-face` rules in `fonts.css` using root-relative URLs (`/assets/...`).
- **Devices, Naming & Deterministic Canvas Grid (`flow.json`):**
  - Always write explicit `w` and `h` matching presets: `phone` (`390×844`), `tablet` (`768×1024`), `pos` (`1280×800`), `desktop` (`1440×900`), or `none` (custom bare frame).
  - Node `id`: kebab-case `<surface>-<screen>[-<variant>]` (e.g., `desktop-checkout`, `desktop-checkout-error`); `file`: `screens/<id>.html`; `title`: concise human label; `section`: declared section `id`.
  - Grid placement: Happy-path screens on row 1 (`y: 0`), left-to-right in flow order with **320px** between adjacent frame edges; first state variants (`empty`, `loading`, `error`) on row 2 (`y: 1800`) aligned under their parent screen's `x`; additional variants on row 3 (`y: 3600`).
  - Sections: `{ "id", "title", "color" }` (`blue`, `green`, `amber`, `red`, `violet`, `gray`, or any CSS color); omit `x/y/w/h` so sections auto-size around member nodes.
- **Interactive Edges & Reusable Components:**
  - Put `data-goto="<target-id>"` on the element triggering a transition and add `{ "from", "to", "label", "style" }` to `flow.json` `edges`. Use `"fromSelector"` only when the trigger comes from a shared component. System-triggered transitions omit both and include `dashed` in `style`. Allowed `style` tokens (space-separated): `dashed`, `error`, `success`, `muted`; labels are 1–3 words.
  - Extract markup repeated across 2+ screens into `components/<name>.html`, invoked via `<x-include src="<name>" prop="value">...</x-include>`. Inside partials, use `{{prop}}`, `{{prop|fallback}}`, and `{{slot}}`; give the partial's root class `.c-<name>` and put its styles in `kit.css` under `/* <name> */` (never `<style>` inside partials).
- **Granular Iterative Edits:** On follow-up feedback, edit only the smallest affected file (`tokens.css`, `kit.css`, one component/screen file, or `flow.json`) and keep `docs/factory/06b-mockery.md` synchronized.

## Execution Steps

1. **Validate Inputs & Mode:** Parse required upstream `<system_state>` JSON blocks (stopping on missing/invalid inputs), lock all inherited constraints, and determine whether this run is **Styled Mode** (`06-ui.md` present), **Wireframe Mode** (explicit post-`sf-ux` pass without `06-ui.md`), or an in-place restyle/update of an existing `docs/factory/mockups/` folder.
2. **Plan Canvas Structure:** Map every `sf-ux` `screens_required` entry, `primary_navigation_pattern`, `key_interactions`, and critical `empty`/`loading`/`error` state (from `sf-ux` / `sf-prd`) to device-sized nodes, sections, edges, and shared components.
3. **Write Mockery Canvas Files:** Create or update `docs/factory/mockups/tokens.css`, `kit.css`, `components/*.html`, `screens/*.html`, and `flow.json` (plus optional `fonts.css`), ensuring zero `CLAUDE.md` file is created inside `docs/factory/mockups/`.
4. **Run Deterministic Checks:** If the `mockery` CLI is installed and supports `check`, run `mockery check docs/factory/mockups --json` (or `npx mockery check docs/factory/mockups --json`) and resolve every error before returning. If `mockery` is absent or v0.2.0 (without `check`), run the static self-checks below directly against the files on disk.
5. **Write 80/20 Manifest & Handoff:** Produce `docs/factory/06b-mockery.md` with exact headings and strict `<system_state>`, print the viewer launch command, and pause for human review.

## Output Format (80/20 Hybrid Artifact)

Produce **80% human-readable narrative** followed by **20% strict machine-readable state** at `docs/factory/06b-mockery.md`. Use these exact Markdown headings in order:

- `### 1. Canvas & Flow Overview` — Fidelity mode (`wireframe` or `styled`), target device(s), section grouping, happy-path flow, and state-variant coverage (`empty`, `loading`, `error`).
- `### 2. Screen & Component Inventory` — Table or list mapping each Mockery node `id`, `file`, `device`, `variant`, and upstream `sf-ux` screen reference, plus extracted shared `<x-include>` components and key edges.
- `### 3. Token Mapping & Viewer Commands` — How `tokens.css` maps `sf-ui` tokens (or neutral wireframe palette), validation check results, and the exact command to launch the local Mockery canvas.

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

Before returning the artifact, run these self-checks:
1. **Valid Strict JSON & Parity:** `<system_state>` contains strict, valid JSON with `"phase": "mockery"`, exact schema keys, `"tokens_synced_from_ui": true` in `styled` mode (`false` in `wireframe` mode), and 1:1 parity with `docs/factory/mockups/flow.json` (`screens`, `sections`, `edges_count`, `components`).
2. **Mockery File Integrity:** `flow.json` parses cleanly; every `node.file` and `<x-include>` target exists; zero `<script>`, `@media`, viewport units, or `position: fixed`; zero raw brand colors outside `tokens.css`; zero `CLAUDE.md` created in `docs/factory/mockups/`.
3. **Zero Leakage:** Every `sf-ux` screen and interaction is represented; zero `explicitly_out_of_scope` features, `hard_constraints` violations, or production app code leaked.

- **Save Location:** When working in a workspace/repository, write the Mockery project to `docs/factory/mockups/` and the 80/20 manifest to `docs/factory/06b-mockery.md` in addition to returning the manifest summary in chat.
- **Viewer Launch & Pure File-Only Fallback:**
  - If `mockery` is installed (`command -v mockery` or local `node_modules/.bin/mockery`), provide `npx mockery docs/factory/mockups` (or `npx mockery` on Mockery v0.3.0+) and offer to start the local viewer for interactive browser inspection.
  - If `mockery` is not installed, succeed cleanly in file-only mode and note that the user can install Mockery later and run `npx mockery docs/factory/mockups` with zero changes to the generated files.
- **Handoff Gate:** Pause for human review and suggest running `sf-review` against upstream artifacts (`sf-vision` + `sf-ux`, plus `sf-ui` in `styled` mode) before advancing to `sf-architecture` (or `sf-ui` if in `wireframe` mode). Never auto-advance.
