# Spec: Triage Agent — v2 Real Investigation

## Problem Statement

In v1, the agent can receive a Sentry alert, rank its business impact, and emit a structured triage report. However, the investigation step is still a mocked seam: it can tell us which files are likely involved, but it cannot look up the real repository state. As a result, the agent cannot reliably answer the two most important operational questions:

1. Which files in the codebase are actually relevant to this error?
2. Who is most likely to own or review the fix?

Without those signals, the triage report is still useful as a summary, but it is not yet actionable enough to reduce the on-call burden in real production incidents.

## Solution

The v2 milestone replaces the mocked code investigation tool with a real GitHub-backed lookup, adds a delivery path for triage output, and persists the outcome in a lightweight audit table. The agent still follows the same v1 contract: it receives a Sentry webhook, verifies the signature, ranks severity deterministically, investigates the codebase, and synthesises a structured triage report. The difference is that the investigation and routing layers now connect to real systems instead of console-only placeholders.

## Goals

- Turn the mocked investigation seam into a real GitHub lookup
- Attach code ownership and proven context to each triage report
- Deliver triage output to a human-facing channel (Slack and/or PagerDuty)
- Record triage results so the team can review, audit, and tune severity later
- Keep the business severity calculation deterministic and auditable

## Non-Goals

- Auto-generating fixes or PRs
- Handling non-Sentry alert sources
- Multi-alert deduplication and incident suppression
- Learning-based severity tuning
- Threading the agent into a broader incident management platform

## User Stories

1. As an on-call engineer, I want the investigation step to use real GitHub data, so that I can see the relevant files and recent code changes behind a production alert.
2. As an on-call engineer, I want triage reports routed to Slack or PagerDuty based on severity, so that I know what to do without opening a separate dashboard.
3. As an engineering manager, I want triage events recorded in a durable store, so that I can audit how decisions were made and review history later.
4. As a team lead, I want suggested owners from the affected files, so that I can route the incident to the correct person quickly.
5. As a developer, I want the investigation seam to be replaced without changing the agent loop, so that v1 and v2 share the same contract.
6. As a developer, I want the system to continue using deterministic severity ranking, so that escalation rules remain explainable and not hidden inside model reasoning.
7. As a platform owner, I want a clear separation between alert handling, investigation, routing, and persistence, so that each layer can evolve independently.

## Functional Requirements

### 1. Real GitHub Investigation

The `investigateCodebase` tool must be replaced by an implementation backed by the GitHub API or a GitHub-compatible client.

The investigation should perform, at minimum:

- search the repository for the culprit symbol or offending file path
- inspect the relevant file(s) around the stack frame or symbol name
- fetch recent commits touching the file
- fetch blame or other change history for the relevant lines or file
- identify candidate owner(s) using repository owners, CODEOWNERS, or the most recent maintainer metadata
- return a structured list of findings, affected files, and suggested owner(s)

The tool contract should remain:

```ts
{
  findings: string[];
  affectedFiles: string[];
  suggestedOwner?: string;
}
```

The exact implementation may expand fields later, but the v2 agent loop must remain compatible with the current interface.

### 2. Severity Routing by Priority

The triage report remains deterministic by severity, but routing should be severity-aware:

- P0 → direct PagerDuty escalation or a dedicated high-priority alert path
- P1 → Slack notification with urgency and code context
- P2 → Slack notification in the default engineering channel
- P3 → log + optionally post a low-priority summary to a monitoring channel

The route selection should be explicit and rule-based, not modeled as a hidden prompt decision.

### 3. D1 Persistence for Audit Trail

Every actionable event must be persisted to Cloudflare D1 in a table named or equivalent to `triage_results`.

Required fields:

- id
- eventId
- title
- project
- level
- businessSeverity
- culprit
- affectedFiles (JSON or string array)
- suggestedOwner
- rationale
- createdAt
- notificationChannel
- notificationStatus
- rawPayload (optional JSON, if size limits allow)

The persistence layer should be append-only for the v2 milestone and should never overwrite a prior triage result for the same event.

### 4. Reporting and Routing Contract

The triage report output contract must include:

- event metadata
- business severity and rationale
- affected files
- suggested owner(s)
- user-facing recommended action
- route destination and notification status

This information should be returned from the agent and then sent to the notification layer, rather than being constructed only in the final log message.

### 5. Guardrails for Non-Actionable Events

The worker should continue to ignore non-trigger events such as `resolved`, `assigned`, and other non-alert actions unless a later milestone explicitly adds support for them.

## System Architecture

```text
Sentry
  │  POST /webhook/sentry
  ▼
Cloudflare Worker
  ├── Verify HMAC-SHA256 signature
  ├── Parse payload
  └── Agent loop
        ├── rankSeverity (deterministic)
        ├── investigateCodebase (GitHub-backed, real)
        ├── synthesize triage report
        ├── persist triage result to D1
        └── route to Slack / PagerDuty
```

## Implementation Decisions

### Dependency Order

Modules should be built in this order:

1. `src/types.ts` — shared domain types and alert payload model
2. `src/tools.ts` — `rankSeverity` and GitHub-backed `investigateCodebase`
3. `src/agent.ts` — agent loop and final report synthesis
4. `src/index.ts` — webhook entrypoint and async execution
5. `src/store.ts` or equivalent — D1 persistence module
6. `src/notifications.ts` — Slack/PagerDuty adapter

### GitHub Investigation Tool

The investigation tool should take structured alert information and use GitHub for context:

- repo name and owner from config or inferred from project metadata
- culprit file from stack trace or Sentry payload
- repo search for symbol or route names
- recent commit history on relevant files
- CODEOWNERS / team ownership lookup
- optional blame on relevant lines

For the v2 milestone, the implementation should be explicit and predictable. It should not require the LLM to guess which repository to inspect; it should use a clear repository mapping or repo metadata configuration.

### D1 Schema and Persistence

A minimal D1 schema should include:

```sql
CREATE TABLE triage_results (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  level TEXT NOT NULL,
  businessSeverity TEXT NOT NULL,
  culprit TEXT,
  affectedFiles TEXT NOT NULL,
  suggestedOwner TEXT,
  rationale TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  notificationChannel TEXT,
  notificationStatus TEXT,
  rawPayload TEXT
);
```

If a table name differs in implementation, it should still follow the same semantics: one record per actionable Sentry event.

### Notification Channel Selection

Routing logic in v2 must remain deterministic and explicit:

- P0 → PagerDuty or equivalent critical pager route
- P1/P2 → Slack channel for triage
- P3 → quiet log only unless a monitoring channel is desired

The route choice should be reflected in the stored record and the final triage report for auditability.

## Testing Decisions

### What to test

1. `rankSeverity` still passes all v1 severity branches
2. `investigateCodebase` is called with the expected inputs and returns a structured result
3. the agent loop includes the real GitHub findings in the final report
4. the persistence layer stores a single result per event
5. notification routing matches severity thresholds
6. invalid signatures still reject requests

### Mocking discipline

Tests should use fake repository and notification adapters rather than mocking the intelligence or the whole agent loop. The goal is to validate the contract and routing logic without depending on live GitHub or external Slack/PagerDuty APIs.

### Required test cases

- fatal event → P0 → PagerDuty route
- error on checkout/auth/api → P1 → Slack route
- error on non-critical project → P2 → Slack route
- warning/info/debug → P3 → log-only route
- GitHub investigation returns affected files and suggested owner
- D1 persist succeeds once for a given event ID
- invalid HMAC signature → 401 response

## Out of Scope

- Auto-fix generation
- PR creation from triage findings
- Multi-source ingestion
- Event deduplication and rate-based incident suppression
- Resolved-event handling
- Model-based severity tuning
- General-purpose incident dashboard

## Success Criteria

The v2 milestone is successful when all of the following are true:

- A real Sentry alert produces a triage report with project-specific code findings
- The investigation step uses actual repository data rather than the v1 mock
- The report is routed to the correct channel by severity
- Each triage event is persisted to D1 with enough metadata to support auditing
- The worker still responds to Sentry quickly and performs investigation asynchronously

## Risks and Constraints

- GitHub API rate limits may throttle code lookup during high-volume incidents
- Repository ownership metadata may be incomplete or absent; fallback owner logic should be explicit
- Large alert payloads may be expensive to persist as raw JSON; a compressed or filtered payload approach may be needed later
- Notification routing must be fail-safe so that a Slack failure does not prevent the triage result from being persisted

## Open Questions

1. Which GitHub repositories and project-to-repo mappings will be authoritative for v2?
2. Should Slack notifications include the full report or a concise summary with a link to the persisted record?
3. Which on-call channel or alerting system should receive P0 events in production?
4. Do we require CODEOWNERS-based ownership lookup, or is a fallback to recent commit authors acceptable in v2?
5. What is the retention policy for triage records in D1?

## Acceptance Summary

v2 is the milestone where the project becomes operationally useful: real code context, real routing, and a durable record of the decision. It preserves the v1 architecture and determinism while replacing the mock seam with actual repository and notification integrations.
