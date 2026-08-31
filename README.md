# bug-triage

Cloudflare Worker that receives error alerts (Sentry today, additional sources planned), ranks business severity, and produces a triage report via an AI agent loop.

## What it does

`POST /webhook/sentry` → verify signature → agent calls `rankSeverity` + `investigateCodebase` → console.log triage report

See [docs/PRD.md](docs/PRD.md) for the full product roadmap and [docs/handoffs/triage-agent.md](docs/handoffs/triage-agent.md) for v1 design context.

## Setup

```bash
npm install
wrangler secret put SENTRY_WEBHOOK_SECRET
```

For v2 investigation/routing, also provide a `PROJECT_REPOSITORY_MAP` JSON env var plus the relevant GitHub, Slack, PagerDuty, and D1 bindings.

## D1 migration

Create the database once, then let Wrangler apply pending files from `migrations/` in order:

```bash
wrangler d1 create triage-results
npm run migrate
```

For future changes, add a new `migrations/*.sql` file and re-run `npm run migrate`.

Bind that database as `TRIAGE_RESULTS` in `wrangler.toml`.

## Run

```bash
wrangler dev
```

Test with the sample payload:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoffs/sample-payload.json
```

> Note: signature verification is skipped when `SENTRY_WEBHOOK_SECRET` is not set in dev.

The only trigger the Worker processes is a Sentry webhook with `"action": "triggered"`.

## Deploy

```bash
wrangler deploy
```
