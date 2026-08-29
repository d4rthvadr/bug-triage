# Triage Agent — Handoff Document

## Problem Statement

When Sentry fires an alert, an on-call engineer manually reads the error, decides how urgent it is, hunts through the codebase for context, and either fixes it or routes it to the right team. This is slow, inconsistent, and interrupts deep work. The triage agent automates that decision loop — receiving the alert, ranking its business impact, investigating the code, and eventually producing a fix or routing it for human review.

## Long-Term Vision

Sentry webhook fires → agent ranks severity and investigates the codebase → for low-complexity issues it generates a mergeable fix; for everything else it produces a structured triage report and routes to the right reviewer with full context already attached.

## What This Version Does (Tracer Bullet)

| Step            | What happens                                                                    |
| --------------- | ------------------------------------------------------------------------------- |
| Receive webhook | `POST /webhook/sentry` on a Cloudflare Worker, HMAC-SHA256 signature verified   |
| Rank severity   | Deterministic tool maps Sentry `level` + project name → P0–P3 business priority |
| Investigate     | Mocked tool returns fake affected files and suggested owner                     |
| Output          | Structured triage report printed to `console.log`                               |

**Stack:** Cloudflare Worker · Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) · TypeScript

## What This Version Explicitly Defers

- GitHub integration — code lookup, blame, PR creation
- Notification routing — Slack, PagerDuty, email
- Persistence — no D1, KV, or audit log
- Auto-fix generation
- Multi-alert deduplication / rate limiting

## Architecture

```
Sentry
  │
  │  POST /webhook/sentry  (HMAC-SHA256 verified)
  ▼
Cloudflare Worker (src/index.ts)
  │
  │  parse payload
  ▼
Agent Loop (src/agent.ts)
  │
  ├─► rankSeverity tool (src/tools.ts)   ← deterministic, no LLM
  │     Sentry level + project → P0/P1/P2/P3
  │
  ├─► investigateCodebase tool (src/tools.ts)  ← MOCKED
  │     returns fake affected files + suggested owner
  │
  └─► Workers AI synthesises triage report
        │
        ▼
      console.log (structured report)
```

## Key Design Decisions

| Decision                                          | Rationale                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Plain Worker, not Durable Object                  | No state needed in v1. Durable Objects add complexity with no v1 benefit.                                             |
| Deterministic severity tool                       | Ranking must be auditable and predictable. LLM reasoning is not appropriate for a binary P0–P3 decision.              |
| Agent responds 200 immediately, runs triage async | Sentry expects a fast HTTP response. Agent work happens after the response is sent.                                   |
| Mocked codebase tool as a seam                    | Forces a clean interface boundary today so the real GitHub integration slots in without restructuring the agent loop. |
| Workers AI for LLM                                | Keeps everything inside Cloudflare — no external API keys, no egress cost for v1.                                     |

## How to Run Locally

```bash
npm install
# Set the Sentry webhook secret (see Sentry project settings → Client Keys)
echo "your-secret" | wrangler secret put SENTRY_WEBHOOK_SECRET
wrangler dev
```

Send a test payload:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -H "sentry-hook-signature: <hmac-sha256-of-body>" \
  -d @docs/handoffs/sample-payload.json
```

A sample payload is at `docs/handoffs/sample-payload.json`.

## Severity Mapping Reference

| Sentry `level`     | Project type                    | Business severity |
| ------------------ | ------------------------------- | ----------------- |
| `fatal`            | any                             | P0                |
| `error`            | checkout / payment / auth / api | P1                |
| `error`            | other                           | P2                |
| `warning` or below | any                             | P3                |

## Seams to Replace Before Next Milestone

1. **`investigateCodebase` in `src/tools.ts`** → replace mock with real GitHub tool (search code, get blame, recent commits on culprit file)
2. **`console.log` in `src/agent.ts`** → replace with Slack webhook or PagerDuty alert routed by severity
3. **Severity mapping in `rankSeverity`** → extend with event rate / affected-user-count signals from Sentry API
4. **No-op on non-`triggered` actions** → handle `resolved` to auto-close routed tickets
