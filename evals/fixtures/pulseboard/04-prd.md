# PulseBoard — Product Requirements Document

### 1. Core User Flows

- Create and configure an HTTP monitor with check interval and expected status code.
- Evaluate consecutive health checks and transition incident state automatically.
- Publish a real-time public status page displaying 90-day uptime bars.
- Deliver signed Slack and generic HTTPS JSON webhook alerts on state transitions.

### 2. Applied Business Logic & Rules

- Every monitor requires two consecutive failed checks before transitioning from `operational` to `degraded` or `outage`, preventing single-packet blips from paging teams.
- Sign all outbound webhook payloads with HMAC-SHA256.
- Enforce zero third-party scripts on public status page routes.
- Required integrations: Slack Incoming Webhooks and Generic HTTPS JSON Webhooks.

### 3. Critical Edge Cases

- **Unresponsive or private probe targets:** Enforce a strict 10-second probe timeout and SSRF private-IP blocklist.
- **Transient webhook failures:** Retry failed webhook deliveries up to 3 times with exponential backoff and log delivery status.
- **Database pool saturation:** Serve cached public status snapshots and display a non-destructive retry banner in the admin dashboard when PostgreSQL connections are exhausted.

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
    "Exponential backoff with 3 retries on failed webhook delivery",
    "Serve cached public status snapshot and admin retry banner when PostgreSQL pool saturates"
  ]
}
</system_state>
