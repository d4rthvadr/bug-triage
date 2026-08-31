# ADR-0001: Keep severity deterministic and scope v2 to real investigation, routing, and persistence

- Status: Accepted
- Date: 2026-08-31

## Context

The bug-triage agent is intended to reduce on-call toil by turning noisy Sentry alerts into actionable, auditable triage decisions. The product must stay grounded in operational reality: alerts must be triaged quickly, the priority model must be explainable, and the implementation must not drift into broad incident-management scope before the core flow is proven.

The v1 tracer bullet establishes the baseline: receive a webhook, verify the Sentry HMAC signature, rank severity deterministically, investigate the codebase via a seam, and output a triage report. This creates the right foundation, but it also creates a risk if the product grows without explicit guardrails.

There are a few major product pressures:

- The team wants the agent to be fast and credible under incident conditions.
- Severity decisions must be explainable to engineers and managers.
- The code investigation step must evolve from a mock into real engineering context.
- The system should avoid feature creep into GitHub/Slack/PagerDuty/D1 use before the core contract is proven.

## Decision

We will enforce the following product decisions going forward:

1. Severity ranking remains deterministic and auditable.
   - `rankSeverity` is a pure function.
   - P0–P3 assignment is based on explicit rules, not LLM discretion.
   - The business rules live in source code and are reviewable in PRs.

2. The v1/v2 roadmap is explicitly scoped.
   - v1: webhook intake, signature verification, deterministic severity, mocked investigation, console report.
   - v2: real GitHub investigation, severity-based routing, D1 persistence.
   - Future milestones remain focused on fixing and tuning, not expanding into unrelated systems.

3. The investigation seam remains a clean contract boundary.
   - The agent loop depends on `investigateCodebase` only via a defined tool interface.
   - The implementation can be swapped from mock to GitHub-backed logic without changing the rest of the agent.

4. Routing and persistence are treated as outward-facing operational layers.
   - Slack and PagerDuty are notification adapters, not the core triage logic.
   - D1 is an audit store for triage results, not a source of truth for decision-making.

5. Non-trigger webhook events remain non-actionable until explicitly added later.
   - Resolved and other non-alert actions are ignored to keep the product focused and avoid accidental automation.

## Consequences

### Positive

- Priority decisions remain explainable to on-call engineers and managers.
- The product does not become a broad incident-management platform before the core use case is proven.
- The mock investigation seam creates a safe upgrade path to full GitHub-aware triage.
- We can add routing and D1 with minimal disruption because the agent loop remains stable.

### Negative

- The product will intentionally defer sophisticated behavior such as auto-fix generation, rate-based tuning, and multi-source ingestion.
- The team must maintain explicit rule definitions for severity rather than letting a model decide priority.
- Real GitHub and notification integrations add operational complexity and introduce external dependencies in v2.

## Follow-up

This ADR is intended to keep the roadmap disciplined. Any future enhancement must either:

- fit within the existing v1/v2/v3/v4/v5 milestone structure, or
- explicitly justify a new scope change in a subsequent ADR.

This prevents feature creep and keeps the current product aligned with the PRD and the tracer-bullet design.
