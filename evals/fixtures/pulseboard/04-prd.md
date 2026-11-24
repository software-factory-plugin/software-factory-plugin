# PulseBoard — Product Requirements Document

Defines core workflows for creating HTTP endpoint monitors, confirming consecutive probe failures to prevent alert noise, publishing public status pages, and delivering signed Slack/webhook notifications.

## Core Flows & Edge Cases

Every monitor requires two consecutive failed checks before transitioning from `operational` to `degraded` or `outage`, preventing single-packet blips from paging teams.

<system_state>
{
  "phase": "prd",
  "core_flows": [
    "Create and configure HTTP monitor with interval and expected status code",
    "Evaluate consecutive health checks and transition incident state",
    "Publish real-time public status page with 90-day uptime bars",
    "Deliver signed Slack and generic JSON webhook alerts"
  ],
  "business_rules": [
    "Require 2 consecutive failed probes before opening an incident",
    "Sign all outbound webhook payloads with HMAC-SHA256",
    "Zero third-party scripts on public status page routes"
  ],
  "required_integrations": [
    "Slack Incoming Webhooks",
    "Generic HTTPS JSON Webhooks"
  ],
  "edge_case_mitigations": [
    "Enforce 10-second probe timeout and SSRF private-IP blocklist",
    "Exponential backoff with 3 retries on failed webhook delivery"
  ]
}
</system_state>
