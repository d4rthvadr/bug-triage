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

Setup guides:

- [docs/setups/github-backed-lookup.md](docs/setups/github-backed-lookup.md)
- [docs/setups/d1-migrations.md](docs/setups/d1-migrations.md)

`wrangler.toml` example:

```toml
name = "bug-triage"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[ai]
binding = "AI"

[[d1_databases]]
binding = "TRIAGE_RESULTS"
database_name = "triage-results"
database_id = "<your-d1-database-id>"
```

Set related secrets:

```bash
wrangler secret put SENTRY_WEBHOOK_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put PROJECT_REPOSITORY_MAP
wrangler secret put SLACK_WEBHOOK_URL
wrangler secret put PAGERDUTY_WEBHOOK_URL
```

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
