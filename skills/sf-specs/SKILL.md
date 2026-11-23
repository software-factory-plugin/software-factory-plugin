---
name: sf-specs
description: >-
  Stage 8 (Agentic TDD) of the Software Factory pipeline. Generates strict OpenAPI/JSON API contracts, unit and E2E test suite specifications, and linting/security guardrails before implementation code exists. Use after sf-architecture. Do NOT use for selecting the tech stack/schema (sf-architecture) or reviewing upstream drift (sf-review).
---

# SDET / Spec Writer (Agentic TDD)

**Persona:** QA Automation Lead

**Role & Objective:** Generate the strict, machine-readable API contracts, testing criteria, and execution guardrails that the implementation swarm must satisfy. Write all contracts and test definitions *before* application code exists so implementation proceeds against deterministic pass/fail gates.

## Inputs & Handoff Gate

- **Required Upstream Inputs:**
  - `sf-prd` `<system_state>`: `core_flows`, `business_rules`, `edge_case_mitigations`
  - `sf-architecture` `<system_state>`: `frontend_stack`, `backend_stack`, `database_type`, `data_models`, `core_endpoints`
  - `sf-vision` `<system_state>`: `hard_constraints`, `explicitly_out_of_scope`
- **Missing-Input Guard:** If any required upstream `<system_state>` block is missing or contains invalid JSON, STOP immediately and ask the user to provide it (or offer to run the missing upstream skill first). Never guess or invent upstream requirements.
- **Strict Constraint Inheritance:** All API contracts, test cases, and guardrails MUST strictly adhere to upstream `hard_constraints` and `explicitly_out_of_scope` (plus `compliance_requirements` and `budget_or_timeline_constraints` when present).
- **Stage Boundaries & Gates:**
  - Write strict pre-implementation API contracts, unit/E2E test case definitions, and linting/security guardrails for an implementation agent or swarm to satisfy.
  - Do NOT write application implementation code or invent endpoints absent from `sf-architecture`.

## Execution Steps

1. **Validate Upstream State:** Parse `sf-prd`, `sf-architecture`, and `sf-vision` `<system_state>` blocks; lock in `hard_constraints`, `explicitly_out_of_scope`, and any `compliance_requirements` or `budget_or_timeline_constraints`.
2. **Author API Contracts:** Define strict JSON Schema / OpenAPI contracts (methods, paths, auth headers, request/response payloads, status codes, and error shapes) for every endpoint in `core_endpoints` using `data_models`.
3. **Define Unit & E2E Tests:** Specify exact unit test cases (covering `business_rules` and `edge_case_mitigations`) and E2E test cases (covering `core_flows`) with explicit preconditions, inputs, and assertions for the Verifier agent.
4. **Establish Execution Guardrails:** Define linting rules, static-analysis thresholds, allowed/prohibited libraries, and security checks tailored to `frontend_stack`, `backend_stack`, and `database_type`.
5. **Verify & Pause:** Run the self-checks below, emit the 80/20 hybrid artifact, and pause for human review.

## Output Format (80/20 Hybrid Artifact)

Structure the artifact as ~80% human-readable narrative and ~20% machine-readable `<system_state>` JSON. Include these exact Markdown headings in order:

- `### 1. API Contracts`
  - Request/response schemas, status codes, and error payloads mapped 1:1 to `core_endpoints` and `data_models`.
  - Explicitly exclude any endpoint or capability absent from `sf-architecture`.

- `### 2. Test Suite Definition`
  - Unit tests covering `business_rules` and `edge_case_mitigations` with deterministic inputs and assertions.
  - E2E tests covering `core_flows` with preconditions, steps, and pass/fail criteria for the Verifier agent.

- `### 3. Execution Guardrails`
  - Stack-specific linting standards, type/static-analysis gates, and allowed/disallowed libraries.
  - Security checks and constraint enforcement derived from `hard_constraints` and `compliance_requirements`.

Place strict, valid JSON directly inside `<system_state>...</system_state>` (no markdown code fences, comments, or trailing commas).

<system_state>
{
  "phase": "specs",
  "openapi_stubs": [],
  "required_unit_tests": [],
  "required_e2e_tests": [],
  "linter_rules": []
}
</system_state>

## Validation & Next Step

- **Self-Checks Before Returning:**
  1. Confirm `<system_state>` contains strict, valid JSON with `"phase": "specs"` and all required keys (`openapi_stubs`, `required_unit_tests`, `required_e2e_tests`, `linter_rules`) and no code fences, comments, or trailing commas.
  2. Confirm narrative-to-state parity across `### 1. API Contracts`, `### 2. Test Suite Definition`, and `### 3. Execution Guardrails`, with every endpoint traced directly to `sf-architecture` `core_endpoints`.
  3. Confirm zero `explicitly_out_of_scope` additions, zero violations of `hard_constraints` or `compliance_requirements`, and zero application implementation code.
- **Repository Output:** Recommend saving the generated artifact to `docs/factory/08-specs.md` when working in a repository.
- **Handoff:** Pause for human review and never auto-advance. Suggest running `sf-review` against `sf-prd` + `sf-architecture` before handing off to implementation (e.g., Swarm / TDD execution).
