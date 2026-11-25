# PulseBoard — Agentic TDD Specifications

### 1. API Contracts

Contract-first HTTP API stubs traced 1:1 to `sf-architecture` endpoints: `GET /status/{slug}` returns `200 text/html` with zero third-party scripts, `GET /api/monitors` lists configured monitors, `POST /api/monitors` creates or updates a `Monitor`, `POST /api/monitors/{id}/test` returns a `CheckResult`, and `POST /api/incidents/{id}/updates` appends a timestamped timeline entry.

### 2. Test Suite Definition

Unit tests verify consecutive-failure state transitions, SSRF RFC1918/loopback blocking, and HMAC-SHA256 webhook signatures; E2E tests validate monitor outage detection and incident resolution webhook retries.

### 3. Execution Guardrails

Enforce strict TypeScript compiler checks (`noImplicitAny`, `noUncheckedIndexedAccess`), disallow `console.log` in production server modules, and require `CSP script-src 'self'` on public status routes.

<system_state>
{
  "phase": "specs",
  "openapi_stubs": [
    "GET /status/{slug} -> 200 text/html (zero third-party script tags)",
    "GET /api/monitors -> 200 Monitor[]",
    "POST /api/monitors -> 201 Monitor",
    "POST /api/monitors/{id}/test -> 200 CheckResult",
    "POST /api/incidents/{id}/updates -> 201 IncidentUpdate"
  ],
  "required_unit_tests": [
    "State transitions require 2 consecutive probe failures before opening incident",
    "SSRF guard blocks RFC1918 and loopback target URLs",
    "Webhook payloads include valid HMAC-SHA256 signature header"
  ],
  "required_e2e_tests": [
    "Create monitor, trigger 2 failing checks, verify public status page shows outage",
    "Resolve incident and verify Slack webhook delivery retry succeeds"
  ],
  "linter_rules": [
    "Zero console.log in production server modules",
    "Strict TypeScript noImplicitAny and noUncheckedIndexedAccess",
    "CSP script-src 'self' on public status routes"
  ]
}
</system_state>
