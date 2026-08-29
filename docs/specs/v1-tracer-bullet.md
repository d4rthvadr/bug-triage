# Spec: Triage Agent — v1 Tracer Bullet

## Problem Statement

On-call engineers receive Sentry error alerts and must manually assess urgency, locate the relevant code, and decide whether to act immediately or defer. This process is slow, inconsistent across engineers, and interrupts focused work — especially outside business hours. There is no standard for what constitutes a P0 vs a P2, and no automatic surfacing of code context at the moment of alert.

## Solution

A Cloudflare Worker receives Sentry webhook events, verifies their authenticity, and hands the alert to an AI agent loop. The agent calls a deterministic severity-ranking tool to assign a business priority (P0–P3), then calls a codebase investigation tool to surface affected files and a suggested owner. The LLM synthesises both tool results into a structured triage report. In v1, the report is written to the console. The Worker responds to Sentry within 200ms; the agent runs asynchronously after the HTTP response is sent.

## User Stories

1. As an on-call engineer, I want incoming Sentry alerts to be automatically ranked P0–P3, so that I know immediately whether to wake up or let it wait until morning.
2. As an on-call engineer, I want the triage report to tell me which files are involved, so that I can navigate to the right code without searching.
3. As an on-call engineer, I want a suggested owner in the triage report, so that I know who to loop in if I can't fix it myself.
4. As an on-call engineer, I want `fatal`-level errors to always be P0 regardless of project, so that no critical outage is ever silently downgraded.
5. As an on-call engineer, I want errors in payment, checkout, auth, and API services to be ranked P1, so that customer-facing failures get a higher priority than internal tooling errors.
6. As an engineering manager, I want severity rankings to be rule-based and not LLM-generated, so that I can audit and challenge a ranking by reading the rules, not interrogating a model.
7. As an engineering manager, I want the severity rules to live in source code and be changeable via PR, so that the team owns the escalation policy.
8. As a developer setting up the system, I want the Sentry webhook signature to be verified on every request, so that the agent cannot be triggered by arbitrary third parties.
9. As a developer, I want the Worker to return HTTP 200 to Sentry immediately, so that Sentry does not retry or flag the integration as failing.
10. As a developer, I want non-alert webhook actions (e.g. `resolved`, `assigned`) to be ignored gracefully, so that the agent only fires on actionable events.
11. As a developer, I want the codebase investigation tool to be a clean, swappable interface, so that the mocked implementation can be replaced with a real GitHub integration without changing the agent loop.
12. As a developer testing locally, I want a sample Sentry payload I can curl at the local dev server, so that I can verify end-to-end flow without a live Sentry project.
13. As a developer, I want the agent loop to have a maximum iteration cap, so that a runaway tool-calling cycle cannot exhaust Workers AI quota.

## Implementation Decisions

### Dependency Order

Modules must be built in this order — each layer depends only on layers below it:

1. **`src/types.ts`** — shared type definitions (`SentryWebhookPayload`, `BusinessSeverity`). No dependencies.
2. **`src/tools.ts`** — `rankSeverity` and `investigateCodebase` implementations. Depends on types only.
3. **`src/agent.ts`** — tool-calling agent loop. Depends on tools and types. Receives `Ai` binding as a parameter (injected, not imported).
4. **`src/index.ts`** — Cloudflare Worker fetch handler, webhook signature verification, payload parsing. Depends on agent and types.

### Webhook Signature Verification

Sentry signs webhook payloads using HMAC-SHA256. The signature is sent in the `sentry-hook-signature` header. Verification uses the Web Crypto API (`crypto.subtle`) — available natively in Cloudflare Workers without any import. The raw request body must be read as text before parsing as JSON to preserve byte-exact content for signature comparison. The `SENTRY_WEBHOOK_SECRET` is stored as a Wrangler secret and injected via the Worker `Env` interface.

### Async Agent Execution

The Worker calls `ctx.waitUntil(runTriageAgent(...))` to run the agent after the HTTP response is sent. This ensures Sentry receives a 200 within the timeout window regardless of LLM latency. The Worker does not stream or return agent output over HTTP in v1.

### Severity Ranking Tool (`rankSeverity`)

The tool is a pure function — no I/O, no LLM involvement. Inputs: Sentry `level`, `culprit`, `project`. Output: `{ businessSeverity: "P0"|"P1"|"P2"|"P3", rationale: string }`. The mapping rules are:

| Sentry level               | Project match                                                           | Result |
| -------------------------- | ----------------------------------------------------------------------- | ------ |
| `fatal`                    | any                                                                     | P0     |
| `error`                    | checkout / payment / auth / api (substring match on project or culprit) | P1     |
| `error`                    | other                                                                   | P2     |
| `warning`, `info`, `debug` | any                                                                     | P3     |

The `rationale` string is included in the final report for auditability.

### Codebase Investigation Tool (`investigateCodebase`) — Mocked

The tool accepts `{ culprit, errorMessage, stackFrames[] }` and returns `{ findings, affectedFiles[], suggestedOwner }`. In v1 the implementation is a deterministic mock that derives values from the inputs — no random data. The interface is the contract; the implementation is the seam.

### Agent Loop

The loop uses the Workers AI tool-calling API with a hard cap of 5 iterations. On each iteration: if the model returns `tool_calls`, execute them, append results to the message history, and continue. If the model returns a plain text response with no tool calls, that is the final triage report — print it and return. If the cap is reached without a final response, log an error.

The system prompt instructs the model to always call both tools before writing the report. This avoids the model skipping tool calls and hallucinating context.

### LLM Model

`@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Cloudflare Workers AI. Bound as `AI` in `wrangler.toml`. No external API keys required.

### Output (v1)

The triage report is written to `console.log` in a fixed structure:

- Event ID, title, project, Sentry level (header)
- Full LLM-synthesised report body (severity, rationale, affected files, owner, recommended action)

Console output is the intentional v1 seam. The call site in `agent.ts` will be replaced with a notification dispatch in v2.

## Testing Decisions

### What makes a good test here

Tests should call `runTriageAgent(payload, mockAi)` with a controlled `mockAi` and assert on the console output or thrown errors. Tests must not reach the network, must not call real Workers AI, and must not depend on internal implementation details like message array structure. The tool functions (`rankSeverity`, `investigateCodebase`) are pure and can be unit-tested directly.

### Seams to test

1. **`rankSeverity(input)`** — one seam, pure function. Test all severity branches: fatal → P0, error + critical project → P1, error + other → P2, warning → P3. These are the most important tests because severity ranking is the core auditable decision.

2. **`runTriageAgent(payload, ai)`** — integration seam. Provide a mock `Ai` that returns canned tool-call sequences and assert that: (a) both tools are called, (b) the final report is logged, (c) the loop terminates on a plain-text response, (d) the loop terminates after 5 iterations if no plain-text response is returned.

3. **Webhook handler signature verification** — test that a request with a missing or incorrect signature returns 401, and a correct signature proceeds to the agent.

### Prior art / test patterns

No tests exist in the codebase yet. Tests should use Vitest (standard for Cloudflare Worker projects via `@cloudflare/vitest-pool-workers`). Worker environment bindings are injected via the test pool config — no manual mocking of the `Env` interface needed.

## Out of Scope

- GitHub integration for real codebase investigation
- Notification routing (Slack, PagerDuty, email)
- Persistence (D1, KV, audit log)
- Auto-fix or PR generation
- Multi-alert deduplication
- Handling of `resolved` or other non-`triggered` Sentry actions
- Rate limiting on the webhook endpoint
- Multi-source ingestion (Datadog, PagerDuty ingest, custom)

## Further Notes

- The `investigateCodebase` mock must derive its output deterministically from inputs (not hardcoded strings) so that tests remain meaningful when the real implementation is swapped in.
- Wrangler's `ctx.waitUntil` requires the `ExecutionContext` to be threaded from the fetch handler down to the agent call. Do not call `runTriageAgent` without `waitUntil` — the Worker runtime will cancel async work after the response is sent if it is not registered.
- The `sentry-hook-signature` header contains only the hex digest, not a `sha256=` prefix (unlike GitHub webhooks). Verification code must not strip a prefix that isn't there.
