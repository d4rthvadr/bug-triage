import type {
  BusinessSeverity,
  InvestigateCodebaseInput,
  InvestigationResult,
  RankSeverityInput,
  RankSeverityResult,
  SentryStackFrame,
} from './types';

const CRITICAL_PROJECTS = ['checkout', 'payment', 'auth', 'api'];

export function rankSeverity(input: RankSeverityInput): RankSeverityResult {
  const level = input.level.toLowerCase();
  const project = input.project.toLowerCase();
  const culprit = input.culprit.toLowerCase();

  if (level === 'fatal') {
    return {
      businessSeverity: 'P0',
      rationale: 'Fatal Sentry events are highest priority and must be escalated immediately.',
    };
  }

  if (level === 'error') {
    const criticalProject = CRITICAL_PROJECTS.some((name) => project.includes(name) || culprit.includes(name));

    if (criticalProject) {
      return {
        businessSeverity: 'P1',
        rationale: 'Error-level production issues affecting checkout, payment, auth, or API flows are customer-facing and require rapid response.',
      };
    }

    return {
      businessSeverity: 'P2',
      rationale: 'Error-level issues outside the customer-critical projects are deferred to normal triage flow.',
    };
  }

  return {
    businessSeverity: 'P3',
    rationale: 'Warnings and lower-severity events are monitored, not escalated by default.',
  };
}

function extractCandidateFiles(stackFrames: SentryStackFrame[]): string[] {
  return [...new Set(stackFrames.map((frame) => frame.filename).filter((filename): filename is string => Boolean(filename)))];
}

function suggestedOwnerFor(culprit: string): string {
  const normalized = culprit.toLowerCase();

  if (normalized.includes('checkout')) return 'checkout-team';
  if (normalized.includes('payment')) return 'payments-team';
  if (normalized.includes('auth')) return 'identity-team';
  if (normalized.includes('api')) return 'platform-team';

  return 'oncall';
}

export function investigateCodebase(input: InvestigateCodebaseInput): InvestigationResult {
  const affectedFiles = extractCandidateFiles(input.stackFrames);
  const findings = [
    `The issue is centered on ${input.culprit}.`,
    `The top error signal is: ${input.errorMessage}.`,
    affectedFiles.length > 0
      ? `Likely affected files: ${affectedFiles.join(', ')}.`
      : 'No stack-frame filenames were present, so the affected file set is limited to the culprit path.',
  ];

  return {
    findings,
    affectedFiles,
    suggestedOwner: suggestedOwnerFor(input.culprit),
  };
}
