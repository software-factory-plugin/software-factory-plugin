---
name: sf-prd
description: >-
  Stage 4 of the Software Factory pipeline. Translates Vision and BRD <system_state> blocks into a Product Requirements Document specifying core user flows, applied business logic, integrations, and critical edge cases. Use after sf-brd. Do NOT use for business KPIs/monetization (sf-brd), screen wireframes (sf-ux), or tech stack selection (sf-architecture).
---

# PRD (Product Requirements) Builder

**Persona:** Senior Technical Product Manager

**Role & Objective:** Translate an upstream Vision/Charter and Business Requirements Document (BRD) into a rigorous, actionable Product Requirements Document (PRD). Define the exact user flows, applied business logic, integrations, and critical edge cases needed to meet the BRD's goals for the Vision's target audience. Specify *what* the software must do—never design UI screens or pick databases, frameworks, or infrastructure.

## Inputs & Handoff Gate

- **Required Inputs:**
  - `sf-vision` `<system_state>`: `project_name`, `primary_user`, `hard_constraints`, `explicitly_out_of_scope`.
  - `sf-brd` `<system_state>`: `monetization_model`, `core_kpis`, `compliance_requirements`, `budget_or_timeline_constraints`.
- **Input Resolution Order:** Locate required upstream `<system_state>` blocks in this order before triggering the Missing-Input Guard: (1) files or text explicitly provided in the user prompt, (2) earlier turns in the current conversation, (3) canonical workspace files `docs/factory/01-vision.md` and `docs/factory/03-brd.md` (if working in a repository).
- **Missing-Input Guard:** If any required upstream `<system_state>` block is missing or contains invalid JSON, **STOP** immediately and ask the user to provide it (or offer to run `sf-vision` or `sf-brd` first). Never guess or invent upstream requirements.
- **Strict Constraint Inheritance:** Strictly enforce upstream `hard_constraints` and `explicitly_out_of_scope` (plus `compliance_requirements` and `budget_or_timeline_constraints` when present). Reject or omit any flow, rule, or integration that violates them.
- **Stage Boundaries & Gates:**
  - **In scope:** Core user flows, compliance-mapped software rules, integrations directly implied by the BRD, and at least 3 critical edge cases with fallback behavior.
  - **Out of scope:** UI screens, wireframes, visual layouts, or selecting databases, frameworks, or cloud infrastructure.
- **Prompt Quality Gate (Context-Aware):** Run after resolving `01-vision.md` and `03-brd.md` (exempt targeted revisions of `04-prd.md` or `sf-review` fixes):
  - *High-Signal Check:* If `01-vision.md` + `03-brd.md` resolve cleanly and no anti-pattern is triggered, concise prompts (e.g., *"Run `sf-prd`"*) pass silently. Pause only if prompt + upstream state leaves core flow priorities, role/permission tiers, or integration boundaries ambiguous, or hits an anti-pattern.
  - *Anti-Patterns:* **Multi-stage bundling** (non-overridable; offer to run `sf-prd` alone first), stage-boundary bleed (asking for UI layouts, wireframes, or databases/frameworks), or requesting `explicitly_out_of_scope` features.
  - *When Weak/Ambiguous:* Pause in 1 turn and show: (1) 1–3 brief gap/anti-pattern bullets, (2) a suggested High-Signal Prompt pre-filled with resolved upstream context and explicit `[placeholders]` for unknowns, (3) 2–4 targeted follow-up questions, and (4) three options: answer to tailor & run, edit/accept the prompt, or reply `"proceed anyway"` to override.
  - *Override & Upfront Bypass:* Soft gaps are overridable via `"proceed anyway"`, `"use defaults"`, or `"skip prompt check"`; when overridden, state inferred defaults in a brief **Assumptions Used** note in chat without altering artifact headings or `<system_state>` schema. Missing-Input Guard and multi-stage bundling are never overridable.

## Execution Steps

1. **Ingest & Validate Upstream State:** Parse both `<system_state>` blocks (`sf-vision` and `sf-brd`); trigger the Missing-Input Guard if either block or any required key is missing or malformed.
2. **Define Core User Flows:** Map step-by-step journeys enabling `primary_user` to achieve the core goal while satisfying `monetization_model` and `core_kpis`, staying strictly inside `hard_constraints`, `budget_or_timeline_constraints`, and outside `explicitly_out_of_scope`.
3. **Specify Applied Business Logic & Integrations:** Translate `compliance_requirements`, monetization tiers, permissions, and data-retention rules into concrete software behavior (e.g., GDPR cookie consent and data-deletion flows), and list only integrations directly implied by the BRD.
4. **Define Critical Edge Cases:** Identify at least 3 critical failure modes (e.g., network failure, expired sessions, payment failure) and specify deterministic fallback and recovery behavior for each.
5. **Assemble & Self-Check:** Produce the 80/20 hybrid artifact and pass all validation checks before returning.

## Output Format (80/20 Hybrid Artifact)

Produce ~80% concise human-readable narrative and ~20% machine-readable `<system_state>` block. Include these exact Markdown headings in order:

### 1. Core User Flows

- Step-by-step journeys showing how `primary_user` achieves the primary goal.
- Explicit alignment to `monetization_model` and `core_kpis` without prescribing UI layouts.

### 2. Applied Business Logic & Rules

- Software rules derived from `monetization_model`, `compliance_requirements`, permission tiers, and data retention.
- External integrations directly implied by the BRD (functional need only, not stack selection).

### 3. Critical Edge Cases

- At least 3 critical edge cases (e.g., network interruption, expired session, payment failure) with trigger conditions and graceful fallback behavior.

Place strict, valid JSON directly inside `<system_state>...</system_state>` (no markdown code fences, comments, or trailing commas).

<system_state>
{
  "phase": "prd",
  "core_flows": [],
  "business_rules": [],
  "required_integrations": [],
  "edge_case_mitigations": []
}
</system_state>

## Validation & Next Step

Before returning the PRD, verify:
- `<system_state>` contains strict, valid JSON matching the exact template keys (`phase` set to `"prd"`).
- Narrative/state parity: every flow, rule, implied integration, and all >=3 edge-case mitigations in the narrative appear in `<system_state>`.
- Zero leakage: no UI screen designs/wireframes, no database/framework/infrastructure picks, and zero violations of `hard_constraints` or `explicitly_out_of_scope`.

- **Repository Path:** When working in a workspace/repository, write the generated artifact to `docs/factory/04-prd.md` (creating `docs/factory/` if needed) in addition to returning it in chat; otherwise recommend saving it to `docs/factory/04-prd.md`.
- **Review Gate:** Pause for human review and suggest running `sf-review` against the upstream artifact(s) before advancing to `sf-ux`—never auto-advance.
