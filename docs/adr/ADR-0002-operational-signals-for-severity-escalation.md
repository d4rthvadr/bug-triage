# ADR-0002: Incorporate operational signals (event rate + user count) into severity escalation

- Status: Proposed
- Date: 2026-09-01

## Context

The v1–v3 severity model ranks business priority based solely on Sentry event level (`fatal`, `error`, `warning`, etc.) and project type (critical services vs. others). This produces a consistent, auditable decision, but it does not account for operational reality during incidents:

1. An `error` on a critical path that fires 50 times per minute is objectively more urgent than the same error firing once per hour.
2. An `error` that affects 10,000 users is more critical than one affecting 50, regardless of its base level.

Without these signals, the on-call engineer must manually escalate alerts, reintroducing the toil that v1–v3 aimed to eliminate.

However, adding signals introduces a risk: if we allow the LLM to decide escalation based on signals, we lose auditability and invite feature creep. The severity model must remain deterministic, rule-based, and reviewable in code.

## Decision

We will extend the v4 severity model to incorporate two operational signals:

1. **Event rate** — If an error group generates > N events within a time window (e.g., 10+ events in 60 minutes), escalate severity by one level.
2. **Affected user count** — If an error group affects > M users (e.g., 100+ users), escalate severity by one level.

### Escalation rules are deterministic:

- Escalation is applied uniformly: P3 → P2, P2 → P1, P1 → P0, P0 stays P0.
- If both signals suggest escalation, we escalate once (not twice).
- The escalation reason (e.g., "high_frequency" or "high_user_impact") is stored in the triage record for audit.
- Thresholds (10 events, 100 users) are defined as named constants and can only be changed via PR review.

### Signals are fetched from Sentry API:

- Before ranking severity, the agent queries Sentry for event count and affected users.
- Signal fetching happens asynchronously after the 200ms response to Sentry.
- If signal fetching fails or times out, the agent defaults to base severity (no escalation).

## Consequences

### Positive

- Triage severity now reflects real incident impact, reducing manual escalation.
- Alert fatigue during high-volume incidents is reduced by treating correlated errors as more critical.
- The system remains auditable: escalation rules are explicit, testable, and reviewable.
- Signals are independent—either can trigger escalation, but not double-counted.
- Thresholds can be tuned via code change and PR discussion, preserving governance.

### Negative

- Adds a new external dependency: Sentry API queries (introduces rate-limit risk).
- Signal fetching adds latency to the triage report (mitigated by async execution).
- Missing or incomplete signal data may reduce escalation accuracy.
- Thresholds are static; they cannot adapt in real-time without a code change.

## Follow-up

This ADR applies specifically to v4 and codifies the escalation strategy as deterministic and auditable, consistent with ADR-0001's commitment to explainability. Any future learning-based tuning (e.g., Bayesian severity updates or ML-driven thresholds) must justify a new ADR that re-evaluates the determinism constraint.
