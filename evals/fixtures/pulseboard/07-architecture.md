# PulseBoard — System Architecture

### 1. Tech Stack

Single-container Node.js 20+ TypeScript HTTP API and in-process probe scheduler backed by PostgreSQL 16, serving zero-script server-rendered HTML public status pages and a lightweight Preact + Tailwind CSS v4 admin console.

### 2. Database Schema

Relational PostgreSQL schema with four core entities: `Monitor`, `CheckResult`, `Incident`, and `WebhookEndpoint`, indexed by monitor and check timestamp for fast 90-day uptime bar queries.

### 3. API & State Boundaries

Public status routes render purely on the server with cached fallback snapshots; the admin UI communicates via JSON REST endpoints for monitor CRUD, on-demand test probes, and incident timeline updates.

<system_state>
{
  "phase": "architecture",
  "frontend_stack": [
    "Server-rendered HTML for public status pages",
    "Preact + Tailwind CSS v4 admin console"
  ],
  "backend_stack": [
    "Node.js 20+ TypeScript HTTP API",
    "In-process HTTP probe scheduler"
  ],
  "database_type": "PostgreSQL 16",
  "data_models": [
    {
      "entity": "Monitor",
      "fields": ["id", "name", "url", "interval_sec", "expected_status", "state", "consecutive_failures"]
    },
    {
      "entity": "CheckResult",
      "fields": ["id", "monitor_id", "status_code", "latency_ms", "ok", "checked_at"]
    },
    {
      "entity": "Incident",
      "fields": ["id", "monitor_id", "severity", "status", "started_at", "resolved_at"]
    },
    {
      "entity": "WebhookEndpoint",
      "fields": ["id", "target_url", "secret_hash", "kind"]
    }
  ],
  "core_endpoints": [
    {
      "method": "GET",
      "path": "/status/:slug",
      "purpose": "Render zero-tracker public status page with 90-day uptime bars"
    },
    {
      "method": "GET",
      "path": "/api/monitors",
      "purpose": "List configured monitors and current health status"
    },
    {
      "method": "POST",
      "path": "/api/monitors",
      "purpose": "Create or update an HTTP endpoint monitor"
    },
    {
      "method": "POST",
      "path": "/api/monitors/:id/test",
      "purpose": "Execute an on-demand test probe with SSRF and timeout guards"
    },
    {
      "method": "POST",
      "path": "/api/incidents/:id/updates",
      "purpose": "Append a timestamped status update to an incident timeline"
    }
  ]
}
</system_state>
