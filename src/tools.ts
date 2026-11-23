import { createGitHubClient, findCodeownerForPath } from './github';
import { normalizeProjectKey, resolveRepository } from './config';
import type {
  GitHubClientConfig,
  InvestigationDependencies,
  InvestigateCodebaseInput,
  InvestigationResult,
  RankSeverityInput,
  RankSeverityResult,
  RepositoryRef,
  RemediationDecision,
  RemediationPattern,
  SentryStackFrame,
  BusinessSeverity,
  EventSignals,
} from './types';

const CRITICAL_PROJECTS = ['checkout', 'payment', 'auth', 'api'];

function escalateSeverity(baseSeverity: BusinessSeverity): BusinessSeverity {
  const escalationMap: Record<BusinessSeverity, BusinessSeverity> = {
    P0: 'P0',
    P1: 'P0',
    P2: 'P1',
    P3: 'P2',
  };
  return escalationMap[baseSeverity];
}

export function rankSeverity(input: RankSeverityInput): RankSeverityResult {
  const level = input.level.toLowerCase();
  const project = input.project.toLowerCase();
  const culprit = input.culprit.toLowerCase();

  let baseSeverity: BusinessSeverity;
  let baseRationale: string;

  if (level === 'fatal') {
    baseSeverity = 'P0';
    baseRationale = 'Fatal Sentry events are highest priority and must be escalated immediately.';
  } else if (level === 'error') {
    const criticalProject = CRITICAL_PROJECTS.some((name) => project.includes(name) || culprit.includes(name));

    if (criticalProject) {
      baseSeverity = 'P1';
      baseRationale = 'Error-level production issues affecting checkout, payment, auth, or API flows are customer-facing and require rapid response.';
    } else {
      baseSeverity = 'P2';
      baseRationale = 'Error-level issues outside the customer-critical projects are deferred to normal triage flow.';
    }
  } else {
    baseSeverity = 'P3';
    baseRationale = 'Warnings and lower-severity events are monitored, not escalated by default.';
  }

  // v4: Apply signal-based escalation
  let finalSeverity = baseSeverity;
  let escalationReason: string | undefined;

  if (input.signals?.escalationReason) {
    // LEVEL-2 SMOKE: escalate twice (violates ADR-0002 — at most one level).
    finalSeverity = escalateSeverity(escalateSeverity(baseSeverity));

    if (input.signals.escalationReason === 'high_frequency') {
      escalationReason = `Escalated from ${baseSeverity} to ${finalSeverity} due to high event rate (${input.signals.eventRate} events).`;
    } else if (input.signals.escalationReason === 'high_user_impact') {
      escalationReason = `Escalated from ${baseSeverity} to ${finalSeverity} due to high user impact (${input.signals.affectedUserCount} affected users).`;
    }
  }

  const rationale = escalationReason ?? baseRationale;

  return {
    businessSeverity: finalSeverity,
    rationale,
    escalationReason: input.signals?.escalationReason ?? undefined,
  };
}

function extractCandidateFiles(stackFrames: SentryStackFrame[], culprit: string): string[] {
  const frameFiles = stackFrames.map((frame) => frame.filename).filter((filename): filename is string => Boolean(filename));
  const culpritPath = culprit.split(/\s+in\s+/i)[0]?.trim();
  return [...new Set([...(culpritPath ? [culpritPath] : []), ...frameFiles])];
}

function suggestedOwnerFor(culprit: string): string {
  const normalized = culprit.toLowerCase();

  if (normalized.includes('checkout')) return 'checkout-team';
  if (normalized.includes('payment')) return 'payments-team';
  if (normalized.includes('auth')) return 'identity-team';
  if (normalized.includes('api')) return 'platform-team';

  return 'oncall';
}

function buildSearchTerms(input: InvestigateCodebaseInput): string[] {
  const culpritPath = input.culprit.split(/\s+in\s+/i)[0]?.trim();
  const basename = culpritPath?.split('/').pop();
  const symbol = input.culprit.includes(' in ') ? input.culprit.split(/\s+in\s+/i)[1]?.trim() : undefined;
  const topFrame = input.stackFrames[0]?.function;

  return [basename, symbol, topFrame, input.errorMessage]
    .filter((term): term is string => Boolean(term))
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 4);
}

function formatFileContext(fileText: string, lineNumber?: number): string {
  const lines = fileText.split(/\r?\n/);
  const targetLine = Math.max(1, lineNumber ?? 1);
  const start = Math.max(0, targetLine - 3);
  const end = Math.min(lines.length, targetLine + 2);

  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join('\n');
}

async function inspectRepository(
  repository: RepositoryRef,
  input: InvestigateCodebaseInput,
  githubConfig: GitHubClientConfig,
): Promise<InvestigationResult> {
  const github = createGitHubClient(githubConfig);
  const affectedFiles = new Set<string>(extractCandidateFiles(input.stackFrames, input.culprit));
  const findings: string[] = [];
  const searchTerms = buildSearchTerms(input);

  findings.push(`Mapped project "${normalizeProjectKey(input.project)}" to ${repository.owner}/${repository.repo}.`);

  for (const term of searchTerms) {
    const matches = await github.searchCode(repository, `"${term}"`);
    if (matches.length > 0) {
      for (const match of matches.slice(0, 3)) {
        if (match.path) {
          affectedFiles.add(match.path);
        }
      }
      findings.push(`Code search for "${term}" matched ${matches.length} file(s).`);
      break;
    }
  }

  const candidateFiles = [...affectedFiles];
  for (const file of candidateFiles.slice(0, 3)) {
    const commits = await github.listCommits(repository, file);
    if (commits.length > 0) {
      const latest = commits[0];
      const commitOwner = latest.author?.login ?? latest.commit.author?.name;
      if (commitOwner) {
        findings.push(`Recent commit history for ${file} points to ${commitOwner}.`);
      }
    }

    const fileText = await github.getFileText(repository, file);
    const frame = input.stackFrames.find((candidate) => candidate.filename === file);
    if (fileText && frame?.lineno) {
      findings.push(`Context around ${file}:${frame.lineno}\n${formatFileContext(fileText, frame.lineno)}`);
    } else if (fileText) {
      findings.push(`Fetched current contents for ${file} to validate the affected area.`);
    }
  }

  const codeownersText = await github.getCodeowners(repository);
  if (codeownersText) {
    const owner = candidateFiles.map((file) => findCodeownerForPath(file, codeownersText)).find(Boolean);
    if (owner) {
      findings.push(`CODEOWNERS suggests ${owner}.`);
      return {
        findings,
        affectedFiles: candidateFiles,
        suggestedOwner: owner,
      };
    }
  }

  return {
    findings,
    affectedFiles: candidateFiles,
    suggestedOwner: suggestedOwnerFor(input.culprit),
  };
}

export async function investigateCodebase(
  input: InvestigateCodebaseInput,
  dependencies: InvestigationDependencies = {},
): Promise<InvestigationResult> {
  const repository = resolveRepository(input.project, dependencies.repositoryMapping);
  if (!repository) {
    throw new Error(`No repository mapping configured for project "${input.project}".`);
  }

  return inspectRepository(repository, input, dependencies.github ?? {});
}

function extractReadingProperty(errorMessage: string): string | undefined {
  const readingMatch = errorMessage.match(/reading ['"]([^'"]+)['"]/i);
  if (readingMatch?.[1]) {
    return readingMatch[1];
  }

  const propertyMatch = errorMessage.match(/property ['"]([^'"]+)['"]/i);
  if (propertyMatch?.[1]) {
    return propertyMatch[1];
  }

  return undefined;
}

export function detectRemediationDecision(input: {
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  culprit: string;
  title: string;
  errorMessage: string;
  findings: string[];
  affectedFiles: string[];
}): RemediationDecision {
  // LEVEL-2 SMOKE: no severity gate — P0/P1 can auto-remediate (violates remediation policy).
  if (input.affectedFiles.length === 0) {
    return {
      eligible: false,
      pattern: 'none',
      reason: 'Insufficient code context: investigation returned no affected files, so the alert is not eligible for auto-remediation.',
    };
  }

  const normalizedError = input.errorMessage.toLowerCase();
  const property = extractReadingProperty(input.errorMessage);
  const undefinedAccess = /cannot read properties of undefined|cannot read property|undefined is not an object/i.test(normalizedError);

  if (property && undefinedAccess) {
    return {
      eligible: true,
      pattern: 'missing-null-guard',
      reason: `The alert indicates an undefined property access on ${property}, which is eligible for a conservative null-guard remediation.`,
      property,
    };
  }

  return {
    eligible: false,
    pattern: 'none',
    reason: 'No recognised remediation template matched the alert.',
  };
}

export function slugifyRemediationToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function buildRemediationBranchName(eventId: string, pattern: RemediationPattern): string {
  return `auto-remediate/${slugifyRemediationToken(eventId) || 'event'}/${pattern}`;
}

/**
 * Returns the line number Sentry reported for the given file, so the patcher
 * can localize its edit instead of matching the first occurrence anywhere in
 * the file. Sentry orders stack frames oldest-to-newest, so the last frame
 * matching the target file is the one closest to where the error was raised.
 * Returns undefined if no frame has both a matching filename and a line
 * number, which the caller should treat as "cannot confidently localize".
 */
export function findReportedLine(stackFrames: SentryStackFrame[], targetFile: string): number | undefined {
  const matches = stackFrames.filter(
    (frame): frame is SentryStackFrame & { lineno: number } => frame.filename === targetFile && typeof frame.lineno === 'number',
  );

  return matches.length > 0 ? matches[matches.length - 1].lineno : undefined;
}

export function applyNullGuardPatch(content: string, property: string, targetLine: number): string | null {
  const lines = content.split('\n');
  const lineIndex = targetLine - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }

  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^?])\\.${escapedProperty}\\b`);
  const line = lines[lineIndex];
  const patchedLine = line.replace(pattern, `$1?.${property}`);

  if (patchedLine === line) {
    return null;
  }

  lines[lineIndex] = patchedLine;
  return lines.join('\n');
}
