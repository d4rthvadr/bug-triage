# Copilot instructions for bug-triage

## Project purpose
This repository is a docs-first Cloudflare Worker for triaging Sentry alerts. The current milestone is the v1 tracer bullet: receive a webhook, verify the HMAC-SHA256 signature, run a deterministic business-severity tool, run a mocked codebase investigation tool, and emit a triage report.

Use README.md, AGENTS.md, docs/PRD.md, and docs/handoffs/triage-agent.md as the primary source of truth before making changes. The repo intentionally keeps the architecture simple and explicit; do not add GitHub, Slack, PagerDuty, or D1 persistence unless the work is clearly targeting a later milestone.

## Working commands
The repo currently defines the project workflow through Wrangler and the sample payload rather than `npm` scripts.

```bash
npm install
wrangler secret put SENTRY_WEBHOOK_SECRET
wrangler dev
```

Sample local verification:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoffs/sample-payload.json
```

Deploy:

```bash
wrangler deploy
```

Notes:
- In local dev, signature verification is skipped when `SENTRY_WEBHOOK_SECRET` is not set.
- There is no checked-in test or lint command in this repo yet. When a test runner is introduced, prefer the narrowest command that targets the changed behavior instead of the full suite.

## High-level architecture
The repo is deliberately small and organized around explicit seams:

- Sentry sends a webhook to `POST /webhook/sentry`.
- The Worker entrypoint (expected in `src/index.ts`) verifies the `sentry-hook-signature` header against the raw request body using HMAC-SHA256.
- The handler parses the payload, then runs the triage agent asynchronously with `ctx.waitUntil(...)` so Sentry receives a fast 200 response.
- The agent loop (expected in `src/agent.ts`) calls two explicit tool boundaries:
  - `rankSeverity` in `src/tools.ts`: deterministic business-priority logic (P0–P3), no LLM involvement.
  - `investigateCodebase` in `src/tools.ts`: mocked v1 codebase inspection seam that should remain easy to replace with a real GitHub lookup in later milestones.
- Workers AI synthesizes the final triage report and logs it to the console in v1.

This architecture is documented in docs/PRD.md and docs/handoffs/triage-agent.md; follow those docs instead of inventing a new system shape.

## Repo-specific conventions
- Keep the severity model auditable and deterministic. `rankSeverity` should be a pure function based on explicit rules, not a model decision.
- Preserve the contract between the webhook layer, the agent loop, and the tool implementations.
- Treat `resolved` and other non-trigger events as non-actionable unless a later milestone explicitly adds support for them.
- Keep the codebase investigation seam mocked or easy to swap in v1; do not add GitHub/Slack/PagerDuty/D1 wiring unless the task explicitly targets a later milestone.
- Match the v1 tracer-bullet design: plain Cloudflare Worker, no Durable Objects for this stage, and fast asynchronous triage after a 200 response.
- Prefer small, explicit modules and interfaces over broad abstractions.
- For every new task, create a dedicated branch and, when parallel development is expected, a separate worktree before editing files. Do not let multiple agents or processes work on the same file in the same repo state.
- If a file already has uncommitted or branch-local changes in another worktree, stop and coordinate rather than editing the same path concurrently.
- After any code edit, run the repo verification gate before finishing: `npm run check` and `npm test`.
- Do not mark work complete until the verification gate passes.

## Branch + worktree workflow
```bash
git switch -c feature/<task-name>
# For parallel work or multi-agent safety:
git worktree add ../bug-triage-<task-name> -b feature/<task-name>
```

This is the default workflow for any follow-up task in this repository. It prevents two processes from modifying the same file at once and keeps each change set isolated.

## Copilot agent lifecycle hooks
Treat these as required lifecycle steps for any automated or Copilot session working in this repo:

- Immediately after any code edit, run `npm run check`.
- After a behavior change or before concluding work, run the repo validation gate: `npm run check && npm test`.
- Before finalizing a response or handing off the task, confirm the validation gate passes and summarize that result.

This repo does not define a dedicated lint script. The active validation commands are the TypeScript check and the Vitest suite:

```bash
npm run check
npm test
```

A repository git hook under `.githooks/pre-commit` may be used as convenience automation, but the authoritative workflow is the Copilot lifecycle rule above.

## Severity model
The project’s severity model is intentionally rule-based:

| Sentry level | Project context | Business severity |
| --- | --- | --- |
| `fatal` | any | P0 |
| `error` | checkout / payment / auth / api | P1 |
| `error` | other | P2 |
| `warning` or below | any | P3 |

This is the canonical escalation logic for the current tracer-bullet implementation.

## What to read first
- README.md
- AGENTS.md
- docs/PRD.md
- docs/handoffs/triage-agent.md
- docs/specs/v1-tracer-bullet.md

These files describe the repository’s actual product constraints and the implementation contract that future code should match.
