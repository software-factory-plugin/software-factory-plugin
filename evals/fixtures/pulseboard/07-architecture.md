# PulseBoard — System Architecture

Single-container Node.js 20+ HTTP server and worker loop backed by PostgreSQL, serving server-rendered public status pages with zero third-party scripts and a lightweight SPA admin console.

<system_state>
{
  "phase": "architecture",
  "frontend_stack": "Server-rendered HTML for public status pages + lightweight Preact/Tailwind admin UI",
  "backend_stack": "Node.js 20+ TypeScript HTTP API + in-process HTTP probe scheduler",
  "database_type": "PostgreSQL 16",
  "data_models": [
    "Monitor(id, name, url, interval_sec, expected_status, state, consecutive_failures)",
    "CheckResult(id, monitor_id, status_code, latency_ms, ok, checked_at)",
    "Incident(id, monitor_id, severity, status, started_at, resolved_at)",
    "WebhookEndpoint(id, target_url, secret_hash, kind)"
  ],
  "core_endpoints": [
    "GET /status/:slug",
    "GET /api/monitors",
    "POST /api/monitors",
    "POST /api/monitors/:id/test",
    "POST /api/incidents/:id/updates"
  ]
}
</system_state>
