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
  if (input.severity === 'P0' || input.severity === 'P1') {
    return {
      eligible: false,
      pattern: 'none',
      reason: 'High-severity alerts escalate only and do not auto-remediate.',
    };
  }

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
