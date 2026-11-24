# PulseBoard — Market Research

Analysis of existing uptime and status-page vendors confirms strong demand for an open, zero-tracker alternative priced transparently for small engineering teams.

## Competitive Landscape & Market Gap

Enterprise tools (Statuspage, PagerDuty) bundle complex incident management and per-seat pricing, whereas hobby monitors lack structured incident timelines and webhook audit trails. PulseBoard fills the gap with fast HTTP probes and privacy-first status pages.

<system_state>
{
  "phase": "market-research",
  "competitors": [
    "Atlassian Statuspage",
    "Better Stack",
    "UptimeRobot"
  ],
  "market_gap_defined": "Privacy-first, self-hostable status page + HTTP health monitor for 2-15 dev teams without per-seat enterprise pricing",
  "validation_status": "Validated",
  "identified_risks": [
    "False-positive alerts from single-region probes",
    "Free-tier abuse on hosted multi-tenant instances"
  ]
}
</system_state>
