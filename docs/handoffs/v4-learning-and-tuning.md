# Triage Agent — v4 Handoff: Learning & Tuning

## Problem Statement

After v3, the agent can rank severity, investigate code, and generate fixes. But two operational gaps remain:

1. **No incident-aware severity** — A P3 error firing 50 times per minute is treated the same as one firing once. A P2 affecting 10,000 users is not escalated. On-call engineers must still manually escalate during incidents.

2. **Alert fatigue and noise** — During incidents, duplicate errors generate duplicate notifications. Resolved issues are not cleaned up in Slack or PagerDuty, leaving stale tickets behind.

This version (v4) addresses both by extending the severity model to incorporate operational signals (frequency, user impact) and adding support for resolved events and deduplication.

## What This Version Does

| Feature             | What happens                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| Event rate signal   | Fetch Sentry issue stats; escalate P3→P2, P2→P1, P1→P0 if > 10 events/60min   |
| User impact signal  | Fetch affected user count; escalate if > 100 users                             |
| Resolved handling   | Listen for `action: "resolved"` and close Slack/PagerDuty tickets              |
| Deduplication       | Suppress duplicate alerts within 10-minute window; update original ticket      |
| Audit trail         | Store escalation reason, event rate, and user count in D1 for review           |

**Stack:** Cloudflare Worker · Workers AI · Sentry API · TypeScript

## What This Version Explicitly Defers

- Learning-based or adaptive severity tuning (thresholds are static, code-reviewed)
- Multi-source incident correlation
- Configurable dedup windows (10 min is hardcoded)
- Resolved-event threading or complex Slack/PagerDuty workflows

## Architecture

```
Sentry webhook (action: "triggered" | "resolved")
  │
  ├─► IF action == "triggered":
  │     ├── Agent loop
  │     │   ├── rankSeverity (base: level + project)
  │     │   ├── queryEventSignals (Sentry API: rate + user count)
  │     │   ├── escalateSeverity (if signals suggest it)
  │     │   ├── checkForDuplicates (query D1 for same culprit/project < 10 min)
  │     │   ├── if duplicate: update original record, suppress routing
  │     │   ├── if new: investigateCodebase + synthesize report
  │     │   ├── persist to D1 with escalation reason + signals
  │     │   └── route to Slack/PagerDuty (if not duplicate)
  │     │
  │     └─► Return 200 to Sentry immediately
  │
  └─► IF action == "resolved":
        ├── Look up triage record by event ID
        ├── Update D1 record with resolution status
        ├── Send closure message to Slack (mark thread resolved)
        ├── Send resolution to PagerDuty (resolve incident)
        └── Return 200 to Sentry
```

## Key Design Decisions

| Decision                                  | Rationale                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Signals remain rule-based, not ML-driven  | Auditability. Escalation thresholds are in code, reviewable via PR.                        |
| Dedup window is 10 minutes, not adaptive  | Simplicity. Static boundaries are predictable and testable. Can be tuned in a future ADR.   |
| Signals are Sentry API only               | Keeps v4 focused. No new external APIs or infrastructure.                                  |
| Both triggered and resolved go through 200 fast response | Sentry expects immediate ack. Signal fetching and routing happen async. |
| Escalation is +1 level max, not cumulative | Prevents over-escalation. Simpler logic, easier to audit.                                  |

## How to Run Locally

```bash
npm install
# Set secrets (including Sentry auth token for API calls)
echo "your-secret" | wrangler secret put SENTRY_WEBHOOK_SECRET
echo "your-token" | wrangler secret put SENTRY_AUTH_TOKEN
wrangler dev
```

Send a test triggered payload:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoffs/sample-payload.json
```

Send a test resolved payload:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoffs/sample-resolved-payload.json
```

## Severity Escalation Reference

| Base Severity | Event Rate | User Impact | Final | Routing               |
| ------------- | ---------- | ----------- | ----- | --------------------- |
| P3            | > 10/60m   | —           | P2    | Slack (engineering)   |
| P3            | —          | > 100 users | P2    | Slack (engineering)   |
| P2            | > 10/60m   | —           | P1    | Slack (urgent)        |
| P2            | —          | > 100 users | P1    | Slack (urgent)        |
| P1            | > 10/60m   | —           | P0    | PagerDuty             |
| P1            | —          | > 100 users | P0    | PagerDuty             |
| P0            | Yes/No     | Yes/No      | P0    | PagerDuty (always)    |

If signal fetching fails, use base severity (no escalation).

## Seams to Replace Before Next Milestone

1. **Event rate and user count thresholds** → tune based on post-incident review metrics
2. **Dedup window (10 min)** → make configurable per project via config or D1 settings table
3. **Resolved-event closure logic** → add thread updates in Slack or PagerDuty comment threads
4. **Sentry API rate-limit handling** → add caching or batch API if signal fetching becomes a bottleneck

## References

- [Spec: v4 Learning & Tuning](../specs/v4-learning-and-tuning.md)
- [ADR-0002: Operational signals for severity escalation](../adr/ADR-0002-operational-signals-for-severity-escalation.md)
- [ADR-0003: Resolved events and deduplication](../adr/ADR-0003-resolved-events-and-deduplication.md)
