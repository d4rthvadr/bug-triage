import { describe, expect, it, vi } from 'vitest';

import { attemptAutoRemediation } from './remediation';

describe('attemptAutoRemediation', () => {
  it('creates a pull request for a recognised null-guard remediation pattern', async () => {
    const adapter = {
      getFile: vi.fn().mockResolvedValue({
        content: 'export function buildProfile() {\n  return currentUser.userId;\n}\n',
        sha: 'sha-1',
      }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      updateFile: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/acme/internal-dashboard/pull/42',
      }),
    };

    const result = await attemptAutoRemediation(
      {
        event: {
          id: 'evt-42',
          title: 'Profile error',
          culprit: 'src/features/profile.ts',
          level: 'error',
          project: 'internal-dashboard',
          exception: {
            values: [
              {
                value: "Cannot read properties of undefined (reading 'userId')",
                stacktrace: {
                  frames: [{ filename: 'src/features/profile.ts', lineno: 2 }],
                },
              },
            ],
          },
        },
        severity: {
          businessSeverity: 'P3',
          rationale: 'Warnings and lower-severity events are monitored, not escalated by default.',
        },
        investigation: {
          findings: ['Context confirms the profile path is affected.'],
          affectedFiles: ['src/features/profile.ts'],
          suggestedOwner: 'oncall',
        },
        errorMessage: "Cannot read properties of undefined (reading 'userId')",
      },
      {
        adapter,
      },
    );

    expect(result.status).toBe('pr-created');
    expect(result.pullRequestNumber).toBe(42);
    expect(result.pullRequestUrl).toBe('https://github.com/acme/internal-dashboard/pull/42');
    expect(adapter.createBranch).toHaveBeenCalledTimes(1);
    expect(adapter.updateFile).toHaveBeenCalledTimes(1);
    expect(adapter.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('skips remediation for P1 alerts', async () => {
    const result = await attemptAutoRemediation(
      {
        event: {
          id: 'evt-p1',
          title: 'Checkout error',
          culprit: 'src/services/checkout/orderService.ts',
          level: 'error',
          project: 'checkout-api',
        },
        severity: {
          businessSeverity: 'P1',
          rationale: 'Error-level production issues affecting checkout, payment, auth, or API flows are customer-facing and require rapid response.',
        },
        investigation: {
          findings: ['Customer-critical issue should not auto-remediate.'],
          affectedFiles: ['src/services/checkout/orderService.ts'],
          suggestedOwner: 'checkout-team',
        },
        // Quoted property so the null-guard pattern matches.
        errorMessage: "Cannot read properties of undefined (reading 'userId')",
      },
      {},
    );

    // LEVEL-2 SMOKE: P1 is now eligible (severity gate removed); no github → skipped.
    expect(result.status).toBe('skipped');
    expect(result.decision.eligible).toBe(true);
  });
});
