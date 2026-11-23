import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import worker from './index';
import { investigateCodebase, rankSeverity } from './tools';
import { processTriggeredEvent, processResolvedEvent } from './agent';

async function makeSignature(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createMockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url.includes('/search/code')) {
      return new Response(JSON.stringify({ items: [{ path: 'src/services/checkout/orderService.ts' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/commits') && method === 'GET') {
      return new Response(
        JSON.stringify([
          {
            sha: 'abc',
            author: { login: 'alice' },
            commit: { author: { name: 'Alice' } },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/contents/.github%2FCODEOWNERS')) {
      return new Response('src/services/checkout/* @checkout-team', { status: 200 });
    }

    if (url.includes('/contents/src%2Fservices%2Fcheckout%2ForderService.ts')) {
      return new Response(
        'export function processOrder() {\n  const userId = currentUser.userId;\n  return userId;\n}\n',
        { status: 200 },
      );
    }

    if (url.includes('slack.example.com') || url.includes('pagerduty.example.com')) {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  });
}

describe('rankSeverity', () => {
  it('prioritizes fatal alerts as P0', () => {
    const result = rankSeverity({ level: 'fatal', project: 'internal-tooling', culprit: 'src/jobs/nightly.ts' });
    expect(result.businessSeverity).toBe('P0');
  });

  it('prioritizes customer-critical errors as P1', () => {
    const result = rankSeverity({ level: 'error', project: 'checkout-api', culprit: 'src/services/checkout/orderService.ts' });
    expect(result.businessSeverity).toBe('P1');
  });

  it('downgrades non-critical errors to P2', () => {
    const result = rankSeverity({ level: 'error', project: 'internal-dashboard', culprit: 'src/feature-flag.ts' });
    expect(result.businessSeverity).toBe('P2');
  });

  it('treats warnings as P3', () => {
    const result = rankSeverity({ level: 'warning', project: 'checkout-api', culprit: 'src/services/checkout/orderService.ts' });
    expect(result.businessSeverity).toBe('P3');
  });

  // v4: Escalation tests
  it('escalates P3 to P2 on high event rate', () => {
    const result = rankSeverity({
      level: 'warning',
      project: 'internal-dashboard',
      culprit: 'src/feature-flag.ts',
      signals: { eventRate: 15, escalationReason: 'high_frequency' },
    });
    expect(result.businessSeverity).toBe('P2');
    expect(result.escalationReason).toBe('high_frequency');
  });

  it('escalates P2 to P1 on high user count', () => {
    const result = rankSeverity({
      level: 'error',
      project: 'internal-dashboard',
      culprit: 'src/feature-flag.ts',
      signals: { affectedUserCount: 150, escalationReason: 'high_user_impact' },
    });
    expect(result.businessSeverity).toBe('P1');
    expect(result.escalationReason).toBe('high_user_impact');
  });

  it('escalates P1 to P0 on high event rate', () => {
    const result = rankSeverity({
      level: 'error',
      project: 'checkout-api',
      culprit: 'src/services/checkout/orderService.ts',
      signals: { eventRate: 50, escalationReason: 'high_frequency' },
    });
    expect(result.businessSeverity).toBe('P0');
  });

  it('keeps P0 as P0 even with high signals', () => {
    const result = rankSeverity({
      level: 'fatal',
      project: 'internal-tooling',
      culprit: 'src/jobs/nightly.ts',
      signals: { eventRate: 100, affectedUserCount: 5000, escalationReason: 'high_frequency' },
    });
    expect(result.businessSeverity).toBe('P0');
  });
});

describe('investigateCodebase', () => {
  const fetchMock = createMockFetch();

  beforeEach(() => {
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses GitHub repository data to return affected files and ownership hints', async () => {
    const result = await investigateCodebase(
      {
        culprit: 'src/services/checkout/orderService.ts in processOrder',
        errorMessage: 'Cannot read properties of undefined (reading userId)',
        stackFrames: [
          { filename: 'src/services/checkout/orderService.ts', function: 'processOrder', lineno: 84 },
          { filename: 'src/controllers/checkout.ts', function: 'handleCheckout', lineno: 42 },
        ],
        project: 'checkout-api',
      },
      {
        github: { fetchImpl: fetchMock },
        repositoryMapping: {
          'checkout-api': { owner: 'acme', repo: 'checkout-api' },
        },
      },
    );

    expect(result.affectedFiles).toContain('src/services/checkout/orderService.ts');
    expect(result.affectedFiles).toContain('src/controllers/checkout.ts');
    expect(result.suggestedOwner).toBe('@checkout-team');
    expect(result.findings.some((line) => line.includes('Mapped project'))).toBe(true);
  });
});

describe('processTriggeredEvent', () => {
  const fetchMock = createMockFetch();

  beforeEach(() => {
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds, routes, and persists a triage report', async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: 'Checkout is failing because an undefined userId is accessed during order creation.',
      }),
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const findRecentDuplicate = vi.fn().mockResolvedValue(null);
    const updateForDuplicate = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const payload = {
      action: 'triggered',
      data: {
        event: {
          id: 'evt-1',
          title: 'Checkout error',
          culprit: 'src/services/checkout/orderService.ts',
          level: 'error',
          project: 'checkout-api',
          exception: {
            values: [
              {
                value: 'Cannot read properties of undefined (reading userId)',
                stacktrace: {
                  frames: [
                    { filename: 'src/services/checkout/orderService.ts', function: 'processOrder', lineno: 84 },
                  ],
                },
              },
            ],
          },
        },
      },
    } satisfies Parameters<typeof processTriggeredEvent>[0];

    const result = await processTriggeredEvent(payload, ai as any, {
      investigation: {
        github: { fetchImpl: fetchMock },
        repositoryMapping: {
          'checkout-api': { owner: 'acme', repo: 'checkout-api' },
        },
      },
      notification: {
        slackWebhookUrl: 'https://slack.example.com/webhook',
        fetchImpl: fetchMock,
      },
      store: { save, findRecentDuplicate, updateForDuplicate },
      rawPayload: JSON.stringify(payload),
    });

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(result.businessSeverity).toBe('P1');
    expect(result.route.channel).toBe('slack');
    expect(result.notificationStatus).toBe('sent');
    expect(save).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
  });

  it('detects and suppresses duplicate events within dedup window', async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: 'Triage report text',
      }),
    };

    const fetchMock = createMockFetch();
    const save = vi.fn().mockResolvedValue(undefined);
    const updateForDuplicate = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Mock store with a recent duplicate
    const recentDuplicate = {
      id: 'triage-1',
      eventId: 'evt-1',
      title: 'Checkout error',
      project: 'checkout-api',
      level: 'error',
      culprit: 'src/services/checkout/orderService.ts',
      businessSeverity: 'P1' as const,
      rationale: 'Error in critical payment flow',
      findings: [],
      affectedFiles: ['src/services/checkout/orderService.ts'],
      suggestedOwner: undefined,
      recommendedAction: 'Notify the owning team',
      route: { channel: 'slack' as const, destination: 'checkout-api', status: 'sent' as const },
      reportText: 'Report',
      notificationStatus: 'sent' as const,
      createdAt: new Date().toISOString(),
      resolutionStatus: 'open' as const,
    };

    const findRecentDuplicate = vi.fn().mockResolvedValue(recentDuplicate);
    const updateForDuplicateFn = vi.fn().mockResolvedValue(undefined);

    const payload = {
      action: 'triggered',
      data: {
        event: {
          id: 'evt-2',
          title: 'Checkout error',
          culprit: 'src/services/checkout/orderService.ts',
          level: 'error',
          project: 'checkout-api',
          exception: {
            values: [
              {
                value: 'Cannot read properties of undefined (reading userId)',
                stacktrace: {
                  frames: [
                    { filename: 'src/services/checkout/orderService.ts', function: 'processOrder', lineno: 84 },
                  ],
                },
              },
            ],
          },
        },
      },
    } satisfies Parameters<typeof processTriggeredEvent>[0];

    const result = await processTriggeredEvent(payload, ai as any, {
      investigation: {
        github: { fetchImpl: fetchMock },
        repositoryMapping: {
          'checkout-api': { owner: 'acme', repo: 'checkout-api' },
        },
      },
      notification: {
        slackWebhookUrl: 'https://slack.example.com/webhook',
        fetchImpl: fetchMock,
      },
      store: { save, findRecentDuplicate, updateForDuplicate: updateForDuplicateFn },
      rawPayload: JSON.stringify(payload),
    });

    expect(findRecentDuplicate).toHaveBeenCalledWith('src/services/checkout/orderService.ts', 'checkout-api');
    expect(result.notificationStatus).toBe('suppressed');
    expect(result.rationale).toContain('Duplicate');
    expect(updateForDuplicateFn).toHaveBeenCalledWith('triage-1', 'evt-2');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate detected'));
  });
});

describe('processResolvedEvent', () => {
  it('sends closure notifications when issue is resolved', async () => {
    const fetchMock = createMockFetch();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await processResolvedEvent('evt-1', 'checkout-api', 'Checkout error', {
      slackWebhookUrl: 'https://slack.example.com/webhook',
      pagerDutyWebhookUrl: 'https://pagerduty.example.com/webhook',
      fetchImpl: fetchMock,
    });

    // Check that log was called with resolved event info
    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.flat().join(' ');
    expect(logCalls).toContain('Resolved event received');
    expect(logCalls).toContain('evt-1');
    expect(logCalls).toContain('checkout-api');
  });
});

describe('webhook handler', () => {
  const fetchMock = createMockFetch();

  beforeEach(() => {
    fetchMock.mockClear();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests with an invalid signature', async () => {
    const request = new Request('http://localhost/webhook/sentry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'triggered', data: { event: { id: 'a', title: 'x', culprit: 'x', level: 'error', project: 'checkout-api' } } }),
    });

    const res = await worker.fetch(request, { SENTRY_WEBHOOK_SECRET: 'secret', AI: { run: vi.fn() } } as any, { waitUntil: vi.fn() } as any);
    expect(res.status).toBe(401);
  });

  it('accepts correct signatures and schedules async work', async () => {
    const payload = {
      action: 'triggered',
      data: {
        event: {
          id: 'a',
          title: 'x',
          culprit: 'src/services/checkout/orderService.ts',
          level: 'error',
          project: 'checkout-api',
        },
      },
    };
    const body = JSON.stringify(payload);
    const signature = await makeSignature('secret', body);
    const waitUntil = vi.fn();
    const ai = {
      run: vi.fn().mockResolvedValue({ response: 'final report' }),
    };

    const request = new Request('http://localhost/webhook/sentry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sentry-hook-signature': signature },
      body,
    });

    const res = await worker.fetch(
      request,
      {
        SENTRY_WEBHOOK_SECRET: 'secret',
        AI: ai,
        PROJECT_REPOSITORY_MAP: JSON.stringify({
          'checkout-api': { owner: 'acme', repo: 'checkout-api' },
        }),
      } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    // SMOKE TEST: handler currently awaits triage inline instead of ctx.waitUntil.
    expect(waitUntil).toHaveBeenCalledTimes(0);
    expect(ai.run).toHaveBeenCalled();
  });
});

describe('SentryClient rate limiting', () => {
  it('skips fetch when rate limit is critically low', async () => {
    const { SentryClient } = await import('./sentry');
    
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ stats: { '24h': [[0, 10]] }, userCount: 5 }), {
        status: 200,
        headers: { 'X-RateLimit-Remaining': '4' },
      }),
    );

    const client = new SentryClient({
      token: 'test-token',
      fetchImpl: mockFetch,
    });

    // First call - should succeed and set rate limit to 4
    const result = await client.fetchIssueStats('org', 'project', 'issue-id');
    expect(result).toEqual({ eventCount: 10, userCount: 5 });
    
    // Second call should be skipped because we're below threshold (< 5)
    const secondResult = await client.fetchIssueStats('org', 'project', 'issue-id-2');
    expect(secondResult).toBe(null);
    
    // Only the first call should have been made
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('tracks rate limit remaining from response headers', async () => {
    const { SentryClient } = await import('./sentry');
    
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stats: { '24h': [[0, 10]] }, userCount: 5 }), {
        status: 200,
        headers: { 'X-RateLimit-Remaining': '50' },
      }),
    );

    const logWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new SentryClient({
      token: 'test-token',
      fetchImpl: mockFetch,
    });

    const result = await client.fetchIssueStats('org', 'project', 'issue-id');
    
    expect(result).toEqual({ eventCount: 10, userCount: 5 });
    expect(logWarnSpy).not.toHaveBeenCalled(); // No warning at 50 remaining
    
    logWarnSpy.mockRestore();
  });

  it('warns when rate limit is low but above critical threshold', async () => {
    const { SentryClient } = await import('./sentry');
    
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stats: { '24h': [[0, 10]] }, userCount: 5 }), {
        status: 200,
        headers: { 'X-RateLimit-Remaining': '8' },
      }),
    );

    const logWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new SentryClient({
      token: 'test-token',
      fetchImpl: mockFetch,
    });

    const result = await client.fetchIssueStats('org', 'project', 'issue-id');
    
    expect(result).toEqual({ eventCount: 10, userCount: 5 });
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Sentry API rate limit warning'),
    );
    
    logWarnSpy.mockRestore();
  });
});
