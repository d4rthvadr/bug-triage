import { describe, expect, it, vi } from 'vitest';

import { runTriageAgent } from './agent';
import { attemptAutoRemediation } from './remediation';
import { detectRemediationDecision, applyNullGuardPatch } from './tools';

describe('remediation detection', () => {
  it('recognizes undefined property access as a null-guard remediation', () => {
    const decision = detectRemediationDecision({
      culprit: 'src/services/users/profile.ts',
      errorMessage: "Cannot read properties of undefined (reading 'userId')",
      findings: ['The issue is centered on src/services/users/profile.ts.'],
      severity: 'P2',
      title: 'Profile lookup error',
    });

    expect(decision.eligible).toBe(true);
    expect(decision.pattern).toBe('missing-null-guard');
    expect(decision.property).toBe('userId');
  });
});

describe('null-guard patching', () => {
  it('adds optional chaining to the first direct property access', () => {
    const patched = applyNullGuardPatch('const id = user.userId;\nreturn id;', 'userId');

    expect(patched).toBe('const id = user?.userId;\nreturn id;');
  });
});

describe('auto-remediation flow', () => {
  it('creates a pull request when the remediation template matches', async () => {
    const github = {
      createBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        url: 'https://github.com/acme/app/pull/7',
      }),
      getFile: vi.fn().mockResolvedValue({
        content: 'export function loadProfile(user) { return user.userId; }',
        sha: 'abc123',
      }),
      updateFile: vi.fn().mockResolvedValue(undefined),
    };

    const outcome = await attemptAutoRemediation(
      {
        event: {
          culprit: 'src/services/users/profile.ts',
          id: 'evt-123',
          level: 'error',
          project: 'internal-dashboard',
          title: 'Profile lookup error',
        },
        errorMessage: "Cannot read properties of undefined (reading 'userId')",
        investigation: {
          affectedFiles: ['src/services/users/profile.ts'],
          findings: ['The issue is centered on src/services/users/profile.ts.'],
          suggestedOwner: 'identity-team',
        },
        severity: {
          businessSeverity: 'P2',
          rationale: 'Error-level issues outside the customer-critical projects are deferred to normal triage flow.',
        },
      },
      {
        adapter: github,
      },
    );

    expect(outcome.status).toBe('pr-created');
    expect(outcome.pullRequestNumber).toBe(7);
    expect(github.createBranch).toHaveBeenCalledWith('auto-remediate/evt-123/missing-null-guard', 'main');
    expect(github.updateFile).toHaveBeenCalledWith(
      'src/services/users/profile.ts',
      'export function loadProfile(user) { return user?.userId; }',
      'auto-remediate/evt-123/missing-null-guard',
      'Apply missing-null-guard remediation for evt-123',
      'abc123',
    );
  });

  it('skips P1 alerts', async () => {
    const outcome = await attemptAutoRemediation(
      {
        event: {
          culprit: 'src/services/checkout/order.ts',
          id: 'evt-456',
          level: 'error',
          project: 'checkout-api',
          title: 'Checkout error',
        },
        errorMessage: "Cannot read properties of undefined (reading 'userId')",
        investigation: {
          affectedFiles: ['src/services/checkout/order.ts'],
          findings: ['The issue is centered on src/services/checkout/order.ts.'],
          suggestedOwner: 'checkout-team',
        },
        severity: {
          businessSeverity: 'P1',
          rationale: 'Error-level production issues affecting checkout, payment, auth, or API flows are customer-facing and require rapid response.',
        },
      },
    );

    expect(outcome.status).toBe('not-applicable');
    expect(outcome.reason).toContain('High-severity');
  });

  it('falls back to a failed status instead of throwing when PR creation fails', async () => {
    const github = {
      createBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockRejectedValue(new Error('GitHub API request failed (422 Unprocessable Entity)')),
      getFile: vi.fn().mockResolvedValue({
        content: 'export function loadProfile(user) { return user.userId; }',
        sha: 'abc123',
      }),
      updateFile: vi.fn().mockResolvedValue(undefined),
    };

    const outcome = await attemptAutoRemediation(
      {
        event: {
          culprit: 'src/services/users/profile.ts',
          id: 'evt-999',
          level: 'error',
          project: 'internal-dashboard',
          title: 'Profile lookup error',
        },
        errorMessage: "Cannot read properties of undefined (reading 'userId')",
        investigation: {
          affectedFiles: ['src/services/users/profile.ts'],
          findings: ['The issue is centered on src/services/users/profile.ts.'],
          suggestedOwner: 'identity-team',
        },
        severity: {
          businessSeverity: 'P2',
          rationale: 'Error-level issues outside the customer-critical projects are deferred to normal triage flow.',
        },
      },
      {
        adapter: github,
      },
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('422');
    expect(outcome.pullRequestNumber).toBeUndefined();
  });
});

describe('agent integration', () => {
  it('logs remediation context in the triage report', async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: 'Profile failures should be guarded before reading userId.',
      }),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const payload = {
      action: 'triggered',
      data: {
        event: {
          culprit: 'src/services/users/profile.ts',
          exception: {
            values: [{ value: "Cannot read properties of undefined (reading 'userId')", stacktrace: { frames: [{ filename: 'src/services/users/profile.ts' }] } }],
          },
          id: 'evt-789',
          level: 'error',
          project: 'internal-dashboard',
          title: 'Profile lookup error',
        },
      },
    };

    await runTriageAgent(payload, ai, {
      remediationAdapter: {
        createBranch: vi.fn().mockResolvedValue(undefined),
        createPullRequest: vi.fn().mockResolvedValue({
          number: 42,
          url: 'https://github.com/acme/app/pull/42',
        }),
        getFile: vi.fn().mockResolvedValue({
          content: 'export function loadProfile(user) { return user.userId; }',
          sha: 'sha-42',
        }),
        updateFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Remediation status: pr-created'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pull request: #42'));
    logSpy.mockRestore();
  });

  it('still emits the triage report when GitHub PR creation fails', async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: 'Profile failures should be guarded before reading userId.',
      }),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const payload = {
      action: 'triggered',
      data: {
        event: {
          culprit: 'src/services/users/profile.ts',
          exception: {
            values: [{ value: "Cannot read properties of undefined (reading 'userId')", stacktrace: { frames: [{ filename: 'src/services/users/profile.ts' }] } }],
          },
          id: 'evt-790',
          level: 'error',
          project: 'internal-dashboard',
          title: 'Profile lookup error',
        },
      },
    };

    const result = await runTriageAgent(payload, ai, {
      remediationAdapter: {
        createBranch: vi.fn().mockRejectedValue(new Error('network error')),
        createPullRequest: vi.fn(),
        getFile: vi.fn().mockResolvedValue({
          content: 'export function loadProfile(user) { return user.userId; }',
          sha: 'sha-43',
        }),
        updateFile: vi.fn(),
      },
    });

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(result).toContain('Profile failures should be guarded');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Remediation status: failed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pull request: none'));
    logSpy.mockRestore();
  });
});
