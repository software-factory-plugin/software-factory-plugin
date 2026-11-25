# PulseBoard — Product Vision & Charter

### 1. Executive Thesis

PulseBoard is a lightweight uptime and incident status dashboard designed for small SaaS engineering teams (2–15 developers) who need sub-minute health checks, clean public status pages, and Slack/webhook alerts without enterprise bloat.

### 2. Target Audience & Vibe

Engineering leads at small SaaS companies (2–15 developers) should configure monitors and ship a clean status page in under five minutes. The visual tone is **minimalist, high-contrast, utilitarian** with zero marketing fluff.

### 3. Non-Negotiables & Out-of-Scope

- Zero third-party analytics trackers on public status pages.
- Strict Node.js 20+ backend with PostgreSQL storage; runs inside a single container.
- Setup completed in under 5 minutes.
- Explicitly out of scope for v1: on-call paging rotations, SMS billing, and enterprise SAML SSO.

<system_state>
{
  "phase": "vision",
  "project_name": "PulseBoard",
  "primary_user": "Small SaaS engineering leads (2-15 developers)",
  "ux_tone": "Minimalist, high-contrast, utilitarian",
  "hard_constraints": [
    "Zero third-party analytics trackers on public status pages",
    "Single-container Node.js 20+ + PostgreSQL deployment",
    "Setup under 5 minutes"
  ],
  "explicitly_out_of_scope": [
    "On-call paging rotations",
    "SMS billing",
    "Enterprise SAML SSO"
  ]
}
</system_state>
