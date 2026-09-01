# ADR-0003: Support resolved webhook actions and multi-alert deduplication in v4

- Status: Proposed
- Date: 2026-09-01

## Context

ADR-0001 established a principle: "Non-trigger webhook events remain non-actionable until explicitly added later." This was a guardrail to prevent scope creep and keep v1–v3 focused on the core triage flow.

v4 introduces two new webhook actions:

1. **Resolved events** — Sentry sends `action: "resolved"` when an alert is marked resolved in the Sentry UI or via API. Currently, we ignore these. But leaving resolved alerts unclean in Slack/PagerDuty creates ticket clutter and confusion.

2. **Multi-alert deduplication** — During high-volume incidents, the same error fires repeatedly. v1–v3 treats each as independent, causing alert fatigue. v4 should detect duplicates and suppress redundant notifications while updating the existing ticket.

Both of these changes improve operational experience but represent a scope expansion from v1–v3. They must be justified as fitting within the v4 milestone without violating the "no feature creep" constraint in ADR-0001.

## Decision

We will add support for two new operational patterns in v4:

### 1. Resolved Event Handling

When Sentry sends a webhook with `action: "resolved"`:

- Look up the original triage record using the event ID
- Construct a closure notification
- Send closure messages to Slack (mark thread as resolved) and PagerDuty (resolve incident)
- Update the D1 record with resolution timestamp and status
- Log the resolution event for audit

### 2. Multi-Alert Deduplication

When a new alert arrives with `action: "triggered"`:

- Before routing, query D1 for recent (< 10 minutes) triage records with the same (culprit, project)
- If found and not yet resolved, treat as duplicate:
  - Suppress the new notification (no Slack/PagerDuty message)
  - Update the original triage record with the new event's metadata (timestamp, rate, user count)
  - Log the deduplication for audit
- If not found or older than 10 minutes, proceed with normal flow

Both patterns remain **deterministic and rule-based**: no LLM reasoning, no hidden thresholds. Dedup is driven by exact culprit + project matching and a static 10-minute window.

## Rationale

These two features are justified within v4's scope for these reasons:

1. **Resolved handling is low-cost and high-value** — It reuses existing notification channels and D1 storage. It does not add new systems or architectural complexity. It directly improves on-call experience.

2. **Deduplication is explicitly scoped to v4** — The v3 spec stated that v4 would include "multi-alert deduplication to suppress noise during an incident." This was the planned boundary; we are not adding new scope, just following through.

3. **Both remain auditable** — Neither pattern involves LLM reasoning or hidden heuristics. Dedup is determined by culprit + time window; closure is a state transition. Both are traceable in D1.

4. **They do not add external dependencies** — No new APIs or services (Sentry API signals are already justified in ADR-0002). No new infrastructure.

## Consequences

### Positive

- Resolved tickets are cleaned up automatically, reducing alert clutter.
- Duplicate alerts suppress noise during incident response.
- Dedup improves on-call experience without adding complexity.
- Both patterns are auditable and rule-based.

### Negative

- Adds webhook action routing logic to the entrypoint (two code paths: triggered vs. resolved).
- Deduplication requires D1 queries, adding latency (mitigated by async execution).
- Dedup window (10 minutes) is static; mismatch to actual incident patterns may cause false positives or negatives.

## Follow-up

This ADR is specific to v4 and justifies the addition of resolved and dedup handling within the approved v3–v4 roadmap. Future v5+ work on multi-source ingestion or incident correlation should re-evaluate these patterns and potentially generalize them (e.g., cross-source dedup, configurable windows).
