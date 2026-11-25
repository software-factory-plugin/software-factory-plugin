# PulseBoard — Market Research

### 1. Competitive Landscape

- **Atlassian Statuspage:** Strong brand recognition, but tiered SaaS pricing ($29–$1,499/mo) and heavy enterprise setup punish small teams.
- **Better Stack:** Clean UI, but bundles complex incident/log suites with per-seat and usage billing.
- **UptimeRobot:** Affordable freemium monitoring, but offers dated status pages and limited structured incident timelines.

### 2. The Market Gap

Small engineering teams (2–15 developers) lack a privacy-first, self-hostable status page and HTTP health monitor with zero third-party trackers and predictable flat pricing instead of per-seat enterprise bloat.

### 3. Industry Trends & Risks

Developer teams increasingly prefer single-container open-core tooling with transparent privacy guarantees. Key risks include false-positive alerts from single-region probes and free-tier abuse on hosted multi-tenant instances. Validation verdict: **Proceed**.

<system_state>
{
  "phase": "market-research",
  "competitors": [
    {
      "name": "Atlassian Statuspage",
      "weakness": "Expensive tiered pricing and complex enterprise setup",
      "pricing_model": "Tiered SaaS ($29-$1,499/month)"
    },
    {
      "name": "Better Stack",
      "weakness": "Bundles heavy incident/log suites with per-seat billing",
      "pricing_model": "Per-seat and usage-based SaaS"
    },
    {
      "name": "UptimeRobot",
      "weakness": "Dated status page UX and limited incident timeline workflows",
      "pricing_model": "Freemium with tiered monitor limits"
    }
  ],
  "market_gap_defined": "Privacy-first, self-hostable status page + HTTP health monitor for 2-15 dev teams without per-seat enterprise pricing",
  "validation_status": "Proceed",
  "identified_risks": [
    "False-positive alerts from single-region probes",
    "Free-tier abuse on hosted multi-tenant instances"
  ]
}
</system_state>
