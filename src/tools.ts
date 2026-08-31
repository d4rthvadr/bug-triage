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
