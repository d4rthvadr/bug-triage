# ADR-0004: Sentry API Rate-Limit Protection

**Date:** 2026-09-01  
**Status:** Accepted  
**Context:** v4 Learning & Tuning implementation  
**Relates to:** [ADR-0002](./ADR-0002-operational-signals-for-severity-escalation.md)

## Problem Statement

In v4, the triage system fetches event rate and affected-user-count signals from the Sentry API to enhance severity ranking. During high-volume incident responses (e.g., 100+ events firing in rapid succession), the system makes one API call per triggered event, creating a risk of hitting Sentry's API rate limits.

**Sentry rate limits:**
- ~1.25 requests/second (4,500 requests/hour) per organization
- High-volume incident: 100 events → 100 API calls in seconds → likely rate-limit hit

**Consequences of rate limit:**
- SentryClient fails to fetch stats
- System falls back to base severity (no escalation)
- Escalation accuracy degrades but system remains stable (graceful degradation)

**Question:** Should we add defensive rate-limit protection, or accept the risk of degraded accuracy?

## Decision

**Implement lightweight rate-limit protection in v4 and optimize in v5 if needed.**

We will:

1. **Track rate-limit quota** via `X-RateLimit-Remaining` response header (Sentry API includes this)
2. **Skip signal fetching** if remaining quota < 5 requests to preserve quota for other services
3. **Log warnings** when approaching limit (< 10 remaining) for operational visibility
4. **Degrade gracefully** to base severity if rate limited (no breaking errors)
5. **Defer batch optimization** (batch API, D1 caching) to v5 after load testing

## Rationale

### Why not use official Sentry SDK?

The official Sentry SDKs are designed for **reporting errors**, not **querying API endpoints**. They lack built-in methods for fetching issue stats, and bundling a heavy client library for one API call would add unnecessary overhead in a Cloudflare Worker context.

Our custom `SentryClient` is lightweight (100 lines), testable, and fit-for-purpose. It is easier to add rate-limit header tracking than to force-fit an SDK designed for a different use case.

### Why not batch API in v4?

Sentry's API documentation does not provide a clear public batch endpoint for fetching issue stats on multiple IDs in one call. While batch operations may exist internally, implementing v4 without relying on undocumented APIs keeps the system maintainable and reduces risk. Load testing after v4 deployment will inform whether batching is necessary.

### Why skip at < 5 remaining?

We leave a small buffer (5 requests) to ensure other services and manual API calls can complete. This is conservative and prevents the rare edge case where all quota is exhausted by the triage worker.

### Why warn at < 10 remaining?

Warnings at < 10 remaining give the on-call team 8 seconds of visibility before fetching stops (at 1.25 req/sec). This is enough time to:
- Check incident metrics in Sentry
- Decide whether to pause the worker
- Adjust thresholds if rate limiting is a consistent problem

## Consequences

### Positive

- **System stability**: No rate-limit errors crash the worker; degradation is graceful
- **Operational visibility**: Warnings log when approaching limits; audit trail includes escalation context
- **Low implementation cost**: 30 lines of code, 3 unit tests, no new dependencies
- **Backward compatible**: No changes to webhook contract or integration points

### Negative

- **Degraded accuracy during rate limiting**: If quota is exhausted, signal-based escalation is skipped; high-volume incidents may not escalate correctly
- **Not a long-term solution**: High-volume deployments will eventually hit limits; v5 optimization is required
- **False sense of safety**: Buffer of 5 requests is conservative but not foolproof; concurrent workers or external API calls can still exhaust quota

### Mitigations

- **Load test before prod**: Measure typical event volume and confirm we don't hit limits under normal circumstances
- **Monitor quota in production**: Set up alerts if `X-RateLimit-Remaining` consistently drops below 20
- **Plan v5 optimization**: After v4 stabilizes, implement caching (D1) or batch API to eliminate the rate-limit risk entirely
- **Make thresholds configurable**: Store EVENT_RATE_THRESHOLD and USER_COUNT_THRESHOLD in D1 or environment so adjustments don't require redeployment

## Alternatives Considered

### 1. Add D1 caching (rejected for v4, planned for v5)

**Store issue stats in D1 with 5-minute TTL** to avoid repeat fetches for the same issue.

- ✅ Eliminates most API calls during incident bursts
- ❌ Adds D1 schema migration and migration management complexity
- ❌ Introduces staleness (5-min cache = late signal update during fast-moving incidents)
- **Decision**: Defer to v5 after v4 load testing confirms caching would help

### 2. Batch API (rejected until upstream clarification)

**Use undocumented or internal Sentry batch endpoint to fetch stats for 10+ issues at once.**

- ✅ Reduces calls from 1 per event to 1 per 10 events
- ❌ Relies on undocumented API (risk of breaking changes)
- ❌ Requires grouping events before fetching (adds complexity)
- ❌ No public documentation on endpoint or guarantees
- **Decision**: Reject for v4; revisit if Sentry publishes batch API

### 3. No rate-limit protection (rejected)

**Accept degraded accuracy during high-volume incidents.**

- ✅ Simplest implementation
- ❌ On-call team loses escalation accuracy when they need it most (during incidents)
- ❌ No visibility into rate-limit state (silent degradation)
- **Decision**: Reject; lightweight protection adds confidence with minimal cost

### 4. Hard fail on rate limit (rejected)

**Throw an error if rate limit is hit; let Sentry webhook fail and retry.**

- ✅ Forces visibility of the problem
- ❌ Creates error noise and webhook retries
- ❌ Delays triage processing for subsequent events
- ❌ Does not align with graceful-degradation philosophy
- **Decision**: Reject; silent degradation is better UX

## Implementation

**File**: `src/sentry.ts`

```typescript
export class SentryClient {
  private rateLimitRemaining: number = 100; // Conservative initial value

  isRateLimited(): boolean {
    return this.rateLimitRemaining < 5; // Skip if < 5 requests remain
  }

  async fetchIssueStats(...): Promise<SentryIssueStats | null> {
    if (this.isRateLimited()) {
      console.warn('Sentry API rate limit approaching; skipping signal fetch');
      return null;
    }

    const response = await this.fetch(...);
    
    // Update quota from header
    const remaining = response.headers.get('X-RateLimit-Remaining');
    if (remaining) {
      this.rateLimitRemaining = parseInt(remaining, 10);
      if (this.rateLimitRemaining < 10) {
        console.warn(`Sentry API rate limit warning: ${this.rateLimitRemaining} remaining`);
      }
    }

    // ... fetch logic ...
  }
}
```

**Tests**: `src/index.test.ts`

- `SentryClient rate limiting > skips fetch when rate limit is critically low` ✓
- `SentryClient rate limiting > tracks rate limit remaining from response headers` ✓
- `SentryClient rate limiting > warns when rate limit is low but above critical threshold` ✓

## Follow-Up Work

1. **v5 optimization**: Implement D1 caching or batch API after load testing
2. **Monitoring**: Add metric for "rate-limit skip events" in production dashboard
3. **Configuration**: Make EVENT_RATE_THRESHOLD and USER_COUNT_THRESHOLD environment-configurable
4. **Escalation**: If rate-limit skips exceed 5% of events in an hour, alert on-call team to investigate

## References

- Sentry API docs: https://docs.sentry.io/api/
- [ADR-0002: Operational signals for severity escalation](./ADR-0002-operational-signals-for-severity-escalation.md)
- [v4 Spec: Learning & Tuning](../specs/v4-learning-and-tuning.md)
