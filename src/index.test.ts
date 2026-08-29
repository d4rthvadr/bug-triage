import { describe, expect, it, vi } from 'vitest';

import worker from './index';
import { runTriageAgent } from './agent';
import { rankSeverity } from './tools';

async function makeSignature(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

describe('runTriageAgent', () => {
  it('calls both tools and logs the final report', async () => {
    const ai = {
      run: vi.fn()
        .mockResolvedValueOnce({
          result: {
            tool_calls: [
              {
                name: 'rankSeverity',
                arguments: { level: 'error', project: 'checkout-api', culprit: 'src/services/checkout/orderService.ts' },
              },
              {
                name: 'investigateCodebase',
                arguments: {
                  culprit: 'src/services/checkout/orderService.ts',
                  errorMessage: 'Cannot read properties of undefined (reading userId)',
                  stackFrames: [{ filename: 'src/services/checkout/orderService.ts', lineno: 84 }],
                },
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            response: 'Checkout is failing because an undefined userId is accessed during order creation.',
          },
        }),
    };

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
            values: [{ value: 'Cannot read properties of undefined (reading userId)', stacktrace: { frames: [{ filename: 'src/services/checkout/orderService.ts', lineno: 84 }] } }],
          },
        },
      },
    };

    const result = await runTriageAgent(payload, ai as any);

    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(result).toContain('Checkout is failing');
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('webhook handler', () => {
  it('rejects requests with an invalid signature', async () => {
    const request = new Request('http://localhost/webhook/sentry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'triggered', data: { event: { id: 'a', title: 'x', culprit: 'x', level: 'error', project: 'checkout-api' } } }),
    });

    const res = await worker.fetch(request, { SENTRY_WEBHOOK_SECRET: 'secret', AI: { run: vi.fn() } }, { waitUntil: vi.fn() } as any);
    expect(res.status).toBe(401);
  });

  it('accepts correct signatures and schedules async work', async () => {
    const payload = { action: 'triggered', data: { event: { id: 'a', title: 'x', culprit: 'src/auth.ts', level: 'error', project: 'auth-service' } } };
    const body = JSON.stringify(payload);
    const signature = await makeSignature('secret', body);
    const waitUntil = vi.fn();
    const ai = {
      run: vi.fn().mockResolvedValue({ result: { response: 'final report' } }),
    };

    const request = new Request('http://localhost/webhook/sentry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sentry-hook-signature': signature },
      body,
    });

    const res = await worker.fetch(request, { SENTRY_WEBHOOK_SECRET: 'secret', AI: ai }, { waitUntil } as any);
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
