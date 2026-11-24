# PulseBoard — Business Requirements Document

PulseBoard operates on an open-core model: MIT self-hosted single container plus a flat \$19/month hosted team plan with zero per-seat surcharges.

## KPIs & Compliance

Primary KPIs track Time-to-First-Monitor (< 5 minutes), alert false-positive rate (< 1%), and 99.95% status page availability. GDPR compliance is simplified by zero third-party cookies or analytics trackers.

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
