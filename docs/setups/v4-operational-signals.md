# v4 Operational Signals Setup

This guide covers the setup required to enable v4 features: event rate signals, affected user count, resolved event handling, and deduplication.

## Overview

v4 extends v3 with:
1. **Operational signals** – fetch event rate and affected user count from Sentry API to inform severity escalation
2. **Resolved event handling** – listen for `resolved` webhooks and auto-close tickets
3. **Multi-alert deduplication** – suppress duplicate alerts within a 10-minute window

## One-time setup

### 1. Set up Sentry authentication (for operational signals)

To use operational signals (event rate, affected user count), you need a Sentry auth token:

```bash
# Generate a token at https://sentry.io/settings/account/api/auth-tokens/
# Token must have 'event:read' scope to fetch issue stats

wrangler secret put SENTRY_AUTH_TOKEN
# Paste your Sentry auth token when prompted
```

**Without this token:** The system gracefully degrades. Signal fetching is skipped, and base severity applies (no escalation from event rate or user count).

### 2. Configure notification webhooks (for resolved events and deduplication)

To send closure notifications, set the Slack and PagerDuty webhook URLs:

```bash
wrangler secret put SLACK_WEBHOOK_URL
# Paste your Slack webhook URL (e.g., https://hooks.slack.com/services/T.../B.../...)

wrangler secret put PAGERDUTY_WEBHOOK_URL
# Paste your PagerDuty integration key or webhook URL
```

**Without these:** Resolved events are logged but no notifications are sent to Slack/PagerDuty.

### 3. Update D1 schema for v4 fields

If you are using D1 persistence, apply the v4 schema migrations to add new columns:

```bash
npm run migrate
```

This adds:
- `eventRate` (integer) – event count in the time window
- `affectedUserCount` (integer) – number of users impacted
- `escalationReason` (text) – 'high_frequency' or 'high_user_impact' if escalation was applied
- `duplicateOf` (text) – triage ID of the original event if this is a duplicate
- `resolutionStatus` (text) – 'open', 'resolved', or 'suppressed'
- `lastEventAt` (timestamp) – for tracking recent duplicates

See [D1 migrations setup](./d1-migrations.md) for more info.

### 4. Local development with signals

In local dev mode (`wrangler dev`), if `SENTRY_AUTH_TOKEN` is not set, signal fetching is skipped:

```bash
# Test without signals (graceful degradation):
wrangler dev
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -d @docs/handoffs/sample-payload.json

# Test with signals (requires token):
wrangler secret put SENTRY_AUTH_TOKEN  # if not already set
wrangler dev
```

## Environment variables reference

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `SENTRY_WEBHOOK_SECRET` | Yes | HMAC-SHA256 signature verification | Your Sentry webhook secret |
| `SENTRY_AUTH_TOKEN` | No* | Fetch event stats from Sentry API | `sntrys_xxx` |
| `SLACK_WEBHOOK_URL` | No* | Send notifications to Slack | `https://hooks.slack.com/services/...` |
| `PAGERDUTY_WEBHOOK_URL` | No* | Send notifications to PagerDuty | `https://events.pagerduty.com/...` |

*Required only if you want that feature; graceful degradation applies otherwise.

## Verification

After setup, verify v4 features:

```bash
# 1. Test triggered event (base severity + signals if available)
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -H "Sentry-Hook-Signature: sha256=<your-hmac>" \
  -d @docs/handoffs/sample-payload.json

# 2. Inspect logs for signal processing
# Expected: "Event rate: ...", "Affected user count: ...", escalation rationale

# 3. Test resolved event
# Edit sample-payload.json to set "action": "resolved"
curl -X POST http://localhost:8787/webhook/sentry \
  -H "Content-Type: application/json" \
  -H "Sentry-Hook-Signature: sha256=<your-hmac>" \
  -d @docs/handoffs/sample-payload.json

# 4. Check for closure notifications in Slack/PagerDuty
```

## Rollback or disable features

- **Disable signals:** Do not set `SENTRY_AUTH_TOKEN`. The system skips signal fetching and uses base severity.
- **Disable resolved events:** Do not set `SLACK_WEBHOOK_URL` or `PAGERDUTY_WEBHOOK_URL`. Resolved events are logged but no notifications sent.
- **Disable deduplication:** Edit `src/agent.ts` to comment out the `findRecentDuplicate()` check in `processTriggeredEvent()`. Requires rebuild.

## Troubleshooting

### No event rate/user count in logs

- Check that `SENTRY_AUTH_TOKEN` is set: `wrangler secret list`
- Verify the token has `event:read` scope in Sentry settings
- Check for 401/403 errors in the Sentry API response

### Closure notifications not sent

- Verify `SLACK_WEBHOOK_URL` and `PAGERDUTY_WEBHOOK_URL` are set
- Check that the webhook URLs are valid and still accessible
- Look for HTTP errors in the console logs during `wrangler dev`

### Duplicates not suppressed

- Ensure D1 is configured and `findRecentDuplicate()` query runs (check logs for "Duplicate detected")
- Verify the duplicate is within the 10-minute window (`DEDUP_WINDOW_MINUTES = 10` in `src/store.ts`)
- Check that the culprit and project match exactly

## Next steps

- See [docs/specs/v4-learning-and-tuning.md](../specs/v4-learning-and-tuning.md) for detailed feature spec
- See [docs/handoffs/v4-learning-and-tuning.md](../handoffs/v4-learning-and-tuning.md) for developer overview
- See [docs/adr/ADR-0002](../adr/ADR-0002-operational-signals-for-severity-escalation.md) for design decisions
