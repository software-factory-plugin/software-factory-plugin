# PulseBoard — Business Requirements Document

### 1. Value Proposition & Monetization

PulseBoard operates on an open-core model: MIT self-hosted single container plus a flat $19/month hosted team plan with zero per-seat surcharges.

### 2. Success Metrics (KPIs)

- Time-to-First-Monitor under 5 minutes.
- False-positive alert rate under 1%.
- Public status page availability >= 99.95%.

### 3. Compliance & Operational Constraints

- GDPR privacy-by-default enforced by zero third-party tracking cookies on public status pages.
- 6-week solo-founder MVP timeline with infrastructure spend capped under $50/month for the initial 500 monitors.

<system_state>
{
  "phase": "brd",
  "monetization_model": "Open-core MIT self-hosted + flat $19/month hosted team tier",
  "core_kpis": [
    "Time-to-First-Monitor under 5 minutes",
    "False-positive alert rate under 1%",
    "Public status page availability >= 99.95%"
  ],
  "compliance_requirements": [
    "GDPR privacy-by-default (zero third-party tracking cookies)"
  ],
  "budget_or_timeline_constraints": [
    "6-week solo-founder MVP timeline",
    "Infrastructure spend under $50/month for initial 500 monitors"
  ]
}
</system_state>
