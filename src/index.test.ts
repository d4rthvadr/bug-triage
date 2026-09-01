import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import worker from './index';
import { investigateCodebase, rankSeverity } from './tools';
import { processTriggeredEvent } from './agent';

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

    if (url.includes('/contents/src%2Ffeatures%2Fprofile.ts')) {
      return new Response(
        'export function buildProfile() {\n  return currentUser.userId;\n}\n',
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
                value: "Cannot read properties of undefined (reading 'userId')",
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
      store: { save },
      rawPayload: JSON.stringify(payload),
    });

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(result.businessSeverity).toBe('P1');
    expect(result.route.channel).toBe('slack');
    expect(result.notificationStatus).toBe('sent');
    expect(save).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
  });

  it('captures remediation audit details when a fix is generated', async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: 'A null guard should be added before reading the profile userId.',
      }),
    };
    const save = vi.fn().mockResolvedValue(undefined);

    const payload = {
      action: 'triggered',
      data: {
        event: {
          id: 'evt-remediate',
          title: 'Profile error',
          culprit: 'src/features/profile.ts',
          level: 'error',
          project: 'internal-dashboard',
          exception: {
            values: [
              {
                value: "Cannot read properties of undefined (reading 'userId')",
                stacktrace: {
                  frames: [
                    { filename: 'src/features/profile.ts', function: 'buildProfile', lineno: 2 },
                  ],
                },
              },
            ],
          },
        },
      },
    } satisfies Parameters<typeof processTriggeredEvent>[0];

    const adapter = {
      getFile: vi.fn().mockResolvedValue({
        content: 'export function buildProfile() {\n  return currentUser.userId;\n}\n',
        sha: 'sha-1',
      }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      updateFile: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({
        number: 17,
        url: 'https://github.com/acme/internal-dashboard/pull/17',
      }),
    };

    await processTriggeredEvent(payload, ai as any, {
      investigation: {
        github: { fetchImpl: fetchMock },
        repositoryMapping: {
          'internal-dashboard': { owner: 'acme', repo: 'internal-dashboard' },
        },
      },
      remediation: {
        adapter,
      },
      notification: {
        fetchImpl: fetchMock,
      },
      store: { save },
      rawPayload: JSON.stringify(payload),
    });

    expect(adapter.createPullRequest).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      remediationEligible: true,
      remediationStatus: 'pr-created',
      remediationPattern: 'missing-null-guard',
      pullRequestNumber: 17,
      pullRequestUrl: 'https://github.com/acme/internal-dashboard/pull/17',
    });
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
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
