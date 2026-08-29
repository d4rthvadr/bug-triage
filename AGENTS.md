# AGENTS.md

## Project purpose

This repo is a Cloudflare Worker for triaging Sentry alerts. The v1 milestone is a tracer bullet: receive a webhook, verify the signature, run a deterministic severity ranking tool, run a mocked codebase investigation tool, and emit a triage report.

## Start here

- [README.md](README.md)
- [docs/PRD.md](docs/PRD.md)
- [docs/handoffs/triage-agent.md](docs/handoffs/triage-agent.md)
- [docs/specs/v1-tracer-bullet.md](docs/specs/v1-tracer-bullet.md)

## Product constraints

- Primary entrypoint: `POST /webhook/sentry`
- Verify the HMAC-SHA256 signature using the `sentry-hook-signature` header
- Use a deterministic severity rule for P0-P3; do not let the LLM choose priority without auditability
- In v1, the codebase investigation tool is a seam and should remain mocked or easy to replace
- The Worker should respond to Sentry quickly and run the triage work asynchronously via `ctx.waitUntil(...)`
- Treat `resolved` or other non-trigger events as non-actionable unless explicitly added in a later milestone

## Local workflow

```bash
npm install
wrangler secret put SENTRY_WEBHOOK_SECRET
wrangler dev
```

Sample local check:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoffs/sample-payload.json
```

> In local dev, signature verification is skipped when `SENTRY_WEBHOOK_SECRET` is not set.

## Architecture expectations

- Cloudflare Worker + Workers AI
- Use `rankSeverity` and `investigateCodebase` as explicit tool boundaries
- Keep the severity model auditable and rule-based
- Favor pure functions and explicit seams over hidden side effects
- Do not add GitHub, Slack, PagerDuty, or D1 persistence unless the work clearly targets a later milestone

## Branch and worktree workflow

For any new task, do not edit files in the main working tree when another session or process may be working on the same repository. Use a dedicated branch and, when needed, a separate worktree before making code changes.

Required workflow:

```bash
git switch -c feature/<task-name>
# if parallel work is expected or another process may be active:
git worktree add ../bug-triage-<task-name> -b feature/<task-name>
```

Rules:
- Never make edits directly in a shared branch when multiple agents are active.
- If a file is already modified in another worktree, stop and coordinate before touching it.
- Keep each task isolated to its own branch/worktree to prevent collisions on the same file.
- When you finish a task, commit the branch and leave the repo in a clean, reviewable state.

## Verification lifecycle

Run validation immediately after code changes and again before finishing a task. This repo does not define a dedicated lint script, so the verification gate is:

```bash
npm run check
npm test
```

For any edit that changes behavior, treat the small verification loop as required:

```bash
npm run check
npm test -- --runInBand
```

Use the same gate before committing or handing off work. This is the repository’s practical "post-edit" and "pre-finish" check.

A repo-local git hook is also recommended so verification runs automatically on commit:

```bash
git config core.hooksPath .githooks
```

The hook script at `.githooks/pre-commit` should run:

```bash
npm run check && npm test
```

## Coding conventions for agents

- Prefer small, explicit modules and interfaces over large abstractions
- Keep the severity mapping in source code and easy to audit via review
- When implementing v1 features, match the design in the tracer-bullet spec and the handoff doc rather than inventing a new system shape
- Preserve the contract between the webhook layer, the agent loop, and the tool implementations
- Add tests around business rule logic and the agent loop, but do not rely on live Workers AI or network calls
- Do not finalize a task until the verification gate passes.

## Current repo status

This repository is now a working v1 tracer-bullet implementation of the bug-triage worker. Continue to follow the v1 requirements before introducing later milestones such as GitHub integration, routing, or auto-fix flows.
