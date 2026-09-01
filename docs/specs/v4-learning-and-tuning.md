# Spec: Triage Agent — v4 Learning & Tuning

## Problem Statement

By v3, the agent can receive a Sentry alert, rank its business impact deterministically, investigate the codebase, generate a mergeable fix for low-complexity issues, and route the result to the right channel. However, the severity model still considers only the Sentry event level and project type — it does not account for operational context such as alert frequency or the number of affected users.

In high-volume incidents, this leads to two problems:

1. **Alert fatigue**: The system treats each alert independently, even when multiple identical errors fire in rapid succession.
2. **Incomplete priority signals**: An error that affects 10,000 users should escalate differently than the same error affecting 50 users, regardless of its categorization.

Additionally, Sentry sends webhook events for non-alert actions such as `resolved`. Currently, the system ignores these, missing an opportunity to clean up and close out resolved tickets automatically.

## Solution

v4 extends the severity ranking model to incorporate operational signals while remaining deterministic and auditable. It also adds support for resolved-event handling and implements a simple deduplication strategy to reduce noise during incidents.

### Core changes:

1. **Enhanced severity model** — incorporate event rate and affected user count into P0–P3 calculation
2. **Resolved-event handling** — listen for `resolved` actions and auto-close routed tickets
3. **Multi-alert deduplication** — detect and suppress duplicate alerts within a time window, updating the existing ticket instead

## Goals

- Reduce alert fatigue by detecting and suppressing repeated failures during incidents
- Improve severity accuracy by factoring in real operational impact (user count, frequency)
- Keep the severity model deterministic and auditable — no hidden LLM reasoning
- Automatically clean up resolved tickets in Slack and PagerDuty
- Maintain backward compatibility with v1–v3 agents and workflows

## Non-Goals

- Learning-based model tuning or Bayesian severity updates
- General-purpose incident deduplication or correlation
- Support for non-Sentry sources (multi-source remains v5)
- Change the core agent loop contract
- Add a dashboard or UI for tuning severity thresholds (manual ADR or code change only)

## User Stories

1. As an on-call engineer, I want duplicate alerts during an incident to be suppressed, so that I don't receive 50 Slack notifications for the same error.
2. As an on-call engineer, I want high-user-impact errors to be escalated even if their Sentry level is `error`, so that I prioritize based on real business impact.
3. As a platform owner, I want resolved alerts to automatically close their Slack/PagerDuty tickets, so that ticket clutter doesn't accumulate.
4. As an engineering manager, I want to see event frequency and user count in triage records for post-incident review.
5. As a developer, I want the severity model to remain auditable and deterministic, so that I can understand and challenge ranking decisions.

## Functional Requirements

### 1. Event Rate Signal

The agent must fetch the event rate for each Sentry alert before calculating severity.

**Behavior:**

- Query Sentry API for the event group's recent event count (e.g., last 60 minutes)
- If event rate exceeds a threshold (e.g., 10+ events in 60 minutes), escalate severity by one level:
  - P3 → P2
  - P2 → P1
  - P1 → P0
  - P0 stays P0
- Store the event rate and escalation decision in the triage record for audit

**Contract:**

```ts
interface EventSignals {
  eventRate?: number;        // events in the time window
  affectedUserCount?: number; // users impacted by this issue
  escalationReason?: string;  // "high_frequency" | "high_user_impact" | null
}
```

### 2. Affected User Count Signal

The agent must fetch the affected user count for each Sentry alert.

**Behavior:**

- Query Sentry API for the number of unique users affected by the issue
- If user count exceeds a threshold (e.g., 100+ users), escalate severity by one level (same escalation rules as event rate)
- If both signals suggest escalation, escalate once (not twice)
- Store the user count and escalation reason in the triage record

**Escalation Rules (deterministic):**

```
Base Severity | High Freq | High Users | Final
--------------+----------+------------+--------
P3            | Yes      | —          | P2
P3            | —        | Yes        | P2
P2            | Yes      | —          | P1
P2            | —        | Yes        | P1
P1            | Yes      | —          | P0
P1            | —        | Yes        | P0
P0            | Yes/No   | Yes/No     | P0
```

### 3. Resolved Event Handling

The webhook handler must process events where `action: "resolved"`.

**Behavior:**

- Parse incoming webhook with `action: "resolved"`
- Look up the original triage record in D1 using the event ID
- Construct a closure message with the event details and timestamp
- Send closure notification to Slack (edit message or new message with "Resolved" status)
- Send closure notification to PagerDuty (resolve incident)
- Update D1 record with resolution timestamp and status

**Contract:**

```ts
interface ResolutionEvent {
  eventId: string;
  project: string;
  title: string;
  status: "resolved";
  dateResolved: string;
}
```

### 4. Multi-Alert Deduplication

The agent must detect and suppress duplicate alerts.

**Deduplication Strategy:**

- Two alerts are duplicates if they share the same culprit, project, and error message (or similar)
- Deduplication window: 10 minutes (configurable)
- When a duplicate is detected:
  - Suppress the new notification (no Slack/PagerDuty message)
  - Update the existing triage record with new event metadata (timestamp, rate, user count)
  - Log the suppression in D1 as a child record or metadata

**Implementation:**

- Query D1 for recent (< 10 min) triage records with the same `(culprit, project)` pair
- If found and still unresolved, treat as duplicate
- Insert a dedup record linking the new event to the original triage ID
- Skip routing, but still store the event for audit

**Contract:**

```ts
interface TriageResult {
  id: string;
  eventId: string;
  duplicateOf?: string;      // if this is a duplicate, link to original
  eventCount: number;         // total events in the dedup group
  lastEventAt: string;        // timestamp of the most recent duplicate
}
```

### 5. Guardrails for Non-Actionable Events

The worker continues to ignore events with actions other than `triggered` and `resolved` (e.g., `assigned`, `regressed`, `regression`).

## System Architecture

```text
Sentry
  │  POST /webhook/sentry (action: "triggered" | "resolved")
  ▼
Cloudflare Worker
  ├── Verify HMAC-SHA256 signature
  ├── Parse payload
  │
  ├─► IF action == "triggered":
  │     ├── Agent loop
  │     │   ├── rankSeverity (v4: incorporates event rate + user count)
  │     │   ├── queryEventSignals (new Sentry API call)
  │     │   ├── investigateCodebase (GitHub-backed, real)
  │     │   ├── synthesize triage report
  │     │   ├── check for duplicates in D1
  │     │   ├── if duplicate: suppress routing, update existing record
  │     │   ├── if new: persist triage result to D1 + route to Slack/PagerDuty
  │     │   └── LLM synthesises report
  │     │
  │     └─► route to Slack / PagerDuty (if not duplicate)
  │
  └─► IF action == "resolved":
        ├── Look up original triage record in D1
        ├── Update record with resolution status
        ├── Send closure messages to Slack/PagerDuty
        └── Log resolution event
```

## Implementation Decisions

### Dependency Order

1. **`src/types.ts`** — add `EventSignals`, `ResolutionEvent`, dedup metadata
2. **`src/sentry.ts`** (new) — Sentry API client for fetching event rate and user count
3. **`src/tools.ts`** — update `rankSeverity()` to accept signals; add escalation rules
4. **`src/agent.ts`** — add signal fetching step; add dedup check logic
5. **`src/store.ts`** — add dedup lookup, resolution status update, child event logging
6. **`src/notifications.ts`** — add `closeTicket()` and `updateTicket()` methods
7. **`src/index.ts`** — add `resolved` action handler

### Sentry API Integration

The Sentry integration should use the authenticated REST API to query:

- Event count for an issue: `GET /api/0/projects/{org}/{project}/issues/{issue_id}/events/latest`
- User count: parsed from the issue metadata or separate endpoint
- Configuration should be injected via environment variables or config

### Escalation Logic

Escalation is rule-based and stored in code:

```ts
function shouldEscalate(
  signals: EventSignals,
  baseLevel: SeverityLevel
): { escalated: boolean; reason?: string } {
  if (signals.eventRate && signals.eventRate > EVENT_RATE_THRESHOLD) {
    return { escalated: true, reason: "high_frequency" };
  }
  if (
    signals.affectedUserCount &&
    signals.affectedUserCount > USER_COUNT_THRESHOLD
  ) {
    return { escalated: true, reason: "high_user_impact" };
  }
  return { escalated: false };
}
```

Thresholds are defined as constants and can be tuned only via code change + PR review (to preserve auditability).

### D1 Schema Additions

Add columns to `triage_results`:

```sql
ALTER TABLE triage_results ADD COLUMN eventRate INTEGER;
ALTER TABLE triage_results ADD COLUMN affectedUserCount INTEGER;
ALTER TABLE triage_results ADD COLUMN escalationReason TEXT;
ALTER TABLE triage_results ADD COLUMN duplicateOf TEXT;     -- links to original triage_id if duplicate
ALTER TABLE triage_results ADD COLUMN resolvedAt TEXT;       -- timestamp when marked resolved
ALTER TABLE triage_results ADD COLUMN resolutionStatus TEXT;  -- "open" | "resolved" | "suppressed"
```

Optional: Create a separate `triage_dedup` table for tracking dedup relationships and audit trail.

### Notification Contract

Update notification methods to handle closure:

```ts
async function closeTicket(
  channelType: "slack" | "pagerduty",
  triageId: string,
  reason: "resolved" | "duplicate",
  metadata?: Record<string, any>
): Promise<void>

async function updateTicket(
  channelType: "slack" | "pagerduty",
  triageId: string,
  newMetadata: Record<string, any>
): Promise<void>
```

## Testing Decisions

### What to test

1. `rankSeverity` with escalation signals still passes v1–v3 branches and correctly escalates on rate/user signals
2. Event rate signal fetching and escalation logic
3. User count signal fetching and escalation logic
4. Duplicate detection identifies same-culprit alerts within time window
5. Duplicate alerts suppress routing but update the original record
6. Resolved events close tickets and update D1
7. Non-actionable events (e.g., `assigned`, `regressed`) are still ignored

### Mocking discipline

- Mock Sentry API calls to return deterministic event rate and user count
- Mock D1 queries for dedup lookup
- Mock Slack/PagerDuty API for ticket closure
- Test agent loop with realistic payloads, not just edge cases

### Required test cases

- high-frequency P3 error → escalated to P2 → Slack notification
- high-user-impact P2 error → escalated to P1 → Slack notification
- duplicate alert within 10 min → suppressed, original record updated with new timestamp
- resolved event → closes Slack thread, updates PagerDuty incident
- non-actionable action (e.g., `assigned`) → ignored, no triage record created

## Out of Scope

- Model-based or learning-based severity tuning (manual rules only)
- Real-time incident correlation across different projects
- Multi-source ingestion (v5)
- Auto-fix PR adjustment based on feedback
- Slack thread-reply threading or message threading
- General-purpose incident dashboard

## Success Criteria

v4 is successful when all of the following are true:

- A high-frequency low-priority error is escalated to P1/P2 based on event rate
- A low-frequency high-user-impact error is escalated based on affected user count
- Duplicate alerts within the 10-minute window suppress subsequent notifications
- Resolved Sentry events close corresponding Slack/PagerDuty tickets
- The system still responds to Sentry quickly (< 200ms)
- All signal fetching and routing happens asynchronously
- Triage records include event rate, user count, and escalation reason for audit

## Risks and Constraints

- Sentry API rate limits may throttle signal fetching during high-volume incidents (mitigation: cache signals in D1 or use batch API)
- Missing or incomplete user count data may reduce escalation accuracy (mitigation: default to no escalation if data unavailable)
- Deduplication window (10 min) may be too short for slow-rolling incident patterns (mitigation: make configurable, monitor false negatives)
- Ticket closure in Slack or PagerDuty may fail; ensure D1 record still updates even if notification fails
- Webhook events for `resolved` may arrive out-of-order with respect to new `triggered` events (mitigation: use idempotency keys)

## Open Questions

1. What are the authoritative thresholds for event rate and affected user count escalation? (recommend: 10 events/60min, 100+ users)
2. Should the deduplication window be configurable per project, or a global constant?
3. For resolved events, should we send a brief summary or full detail in the closure notification?
4. Should dedup records create a separate D1 table or be nested in `triage_results`?
5. What Sentry API endpoints should we use for fetching signals, and are there rate-limit considerations?

## Acceptance Summary

v4 is where the triage system becomes noise-aware and operationally intelligent: signals are factored in deterministically, duplicate alerts are suppressed, and resolved issues are cleaned up automatically. It preserves the v1–v3 architecture while adding layers of sophistication without losing auditability.
