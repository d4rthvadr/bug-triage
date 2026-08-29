# bug-triage

Cloudflare Worker that receives Sentry webhooks, ranks business severity, and produces a triage report via an AI agent loop.

## What it does

`POST /webhook/sentry` → verify signature → agent calls `rankSeverity` + `investigateCodebase` → console.log triage report

See [docs/handoff/triage-agent.md](docs/handoff/triage-agent.md) for full design context.

## Setup

```bash
npm install
wrangler secret put SENTRY_WEBHOOK_SECRET
```

## Run

```bash
wrangler dev
```

Test with the sample payload:

```bash
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoff/sample-payload.json
```

> Note: signature verification is skipped when `SENTRY_WEBHOOK_SECRET` is not set in dev.

## Deploy

```bash
wrangler deploy
```
