# PulseBoard — Agentic TDD Specifications

Contract-first API stubs, unit tests, E2E journeys, and static security/lint guardrails written prior to implementation code.

<system_state>
{
  "phase": "specs",
  "openapi_stubs": [
    "GET /status/{slug} -> 200 text/html (zero third-party script tags)",
    "POST /api/monitors -> 201 Monitor",
    "POST /api/monitors/{id}/test -> 200 CheckResult"
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
