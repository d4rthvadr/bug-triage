# Bug Triage Agent — Product Requirements Document

## Overview

Bug Triage Agent is an automated on-call assistant that listens for Sentry error alerts, evaluates their business impact, investigates the affected code, and either generates a mergeable fix or routes the issue to the right engineer with full context attached.

The core problem it solves: on-call engineers spend significant time on triage work that is largely mechanical — reading an alert, judging its urgency, finding the relevant code, and deciding what to do next. This interrupts focused work and introduces inconsistency in how issues are prioritised and handled.

---

## Goals

- Reduce mean-time-to-triage (MT3) for Sentry alerts
- Eliminate inconsistent severity judgements across engineers
- Surface code context automatically so the engineer who does act can move faster
- Build toward auto-remediation for well-understood error classes

## Non-Goals

- Replace human judgement for ambiguous or novel failures
- Become a general-purpose incident management platform
- Handle non-Sentry alert sources — Sentry only for now; other sources (PagerDuty ingest, Datadog, custom webhooks) are a future consideration

---

## User Stories

| As a…               | I want…                                                           | So that…                                                    |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| On-call engineer    | Sentry alerts auto-triaged with a P0–P3 priority                  | I don't have to manually assess every alert at 2am          |
| On-call engineer    | The triage report to include affected files and a suggested owner | I can act immediately without hunting through the codebase  |
| Engineering manager | Consistent severity rankings across the team                      | I can trust the escalation signal                           |
| Senior engineer     | Auto-generated fix PRs for known error patterns                   | Low-complexity bugs are resolved without human intervention |
| Any engineer        | A clear audit trail of why a severity was assigned                | I can challenge or override the decision with context       |

---

## Functional Requirements

### v1 — Tracer Bullet (completed)

- [x] Receive Sentry webhook at `POST /webhook/sentry`
- [x] Verify HMAC-SHA256 webhook signature
- [x] Parse alert payload and extract: event ID, title, level, culprit, project, stack frames
- [x] Rank business severity deterministically (P0–P3) based on Sentry level and project
- [x] Invoke codebase investigation tool (mocked) and return affected files + suggested owner
- [x] LLM synthesises a structured triage report
- [x] Output triage report to console

### v2 — Real Investigation (completed)

- [x] Replace mocked codebase tool with GitHub integration: search code, get blame, fetch recent commits on culprit file
- [x] Route triage report to Slack channel or PagerDuty based on severity
- [x] Persist triage results to Cloudflare D1 for audit trail

### v3 — Auto-Remediation (completed)

- [x] For P2/P3 errors with a recognised pattern, generate a candidate fix
- [x] Open a GitHub PR with the fix and triage report as description
- [x] For P0/P1, skip auto-fix and escalate directly with full context

### v5 — Multi-Source Ingestion (planned)

- [ ] Abstract webhook handler behind a normalised `AlertEvent` interface
- [ ] Add ingestion adapters for additional sources (e.g. Datadog, PagerDuty, custom)
- [ ] Route all sources through the same agent loop without changes to triage logic

### v4 — Learning & Tuning (completed)

- [x] Incorporate event rate and affected-user-count signals into severity ranking
- [x] Handle `resolved` webhook actions to auto-close routed tickets
- [x] Multi-alert deduplication to suppress noise during an incident

---

## Non-Functional Requirements

| Requirement           | Target                                                    |
| --------------------- | --------------------------------------------------------- |
| Webhook response time | < 200ms (agent runs async after response)                 |
| Triage report latency | < 30s end-to-end                                          |
| Availability          | Cloudflare Worker SLA (99.99%)                            |
| Secret handling       | Webhook secret stored as Wrangler secret, never in source |

---

## System Architecture

```
Sentry
  │  POST /webhook/sentry
  ▼
Cloudflare Worker
  ├── Signature verification (HMAC-SHA256)
  ├── Payload parser
  └── Agent loop (Workers AI — tool calling)
        ├── rankSeverity      [deterministic]
        ├── investigateCodebase  [v1: mocked → v2: GitHub]
        └── Triage report
              ├── v1: console.log
              ├── v2: Slack / PagerDuty
              └── v3: GitHub PR
```

---

## Severity Model

| Sentry `level`     | Project type                    | Business priority | Expected response               |
| ------------------ | ------------------------------- | ----------------- | ------------------------------- |
| `fatal`            | any                             | P0                | Page on-call immediately        |
| `error`            | checkout / payment / auth / api | P1                | Notify on-call within 15 min    |
| `error`            | other                           | P2                | Ticket for next working session |
| `warning` or below | any                             | P3                | Log and monitor                 |

The severity mapping is deterministic (no LLM). Rules are explicit and auditable. Engineers can propose rule changes via PR.

---

## Milestones

| Milestone          | Scope                              | Success criteria                                                |
| ------------------ | ---------------------------------- | --------------------------------------------------------------- |
| v1 — Tracer bullet | Webhook → agent → console.log      | End-to-end flow works locally with sample payload               |
| v2 — Real signals  | GitHub integration + Slack routing | Real Sentry alert produces a Slack message with code context    |
| v3 — Auto-fix      | PR generation for P2/P3            | At least one real bug fixed by agent without human intervention |
| v4 — Tuning        | Rate signals, deduplication        | MT3 reduced by measurable amount vs. baseline                   |

---

## Open Questions

1. What is the authoritative list of "critical" projects/services for the P1 rule?
2. Who approves auto-generated PRs — a specific reviewer, or CODEOWNERS?
3. Should the agent comment on an existing Sentry issue rather than (or in addition to) Slack?
4. What is the escalation path if the agent itself fails?
