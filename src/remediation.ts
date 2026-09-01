import { applyNullGuardPatch, buildRemediationBranchName, detectRemediationDecision } from './tools';
import type {
  GitHubRemediationConfig,
  InvestigationResult,
  RemediationCandidateFix,
  RemediationOutcome,
  RankSeverityResult,
  SentryEvent,
} from './types';

export interface GitHubRemediationAdapter {
  getFile(path: string, ref: string): Promise<{ content: string; sha: string }>;
  createBranch(branchName: string, baseBranch: string): Promise<void>;
  updateFile(path: string, content: string, branchName: string, message: string, sha: string): Promise<void>;
  createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function toBase64(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(content: string): string {
  const sanitized = content.replace(/\s+/g, '');
  const binary = atob(sanitized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

async function githubRequest<T>(config: GitHubRemediationConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl ?? 'https://api.github.com'}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status} ${response.statusText}): ${await response.text()}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function getFile(config: GitHubRemediationConfig, path: string, ref: string): Promise<{ content: string; sha: string }> {
  const response = await githubRequest<{
    content: string;
    encoding: string;
    sha: string;
  }>(config, `/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);

  if (response.encoding !== 'base64') {
    throw new Error(`Unsupported GitHub content encoding: ${response.encoding}`);
  }

  return {
    content: fromBase64(response.content),
    sha: response.sha,
  };
}

export function createGitHubRemediationAdapter(config: GitHubRemediationConfig): GitHubRemediationAdapter {
  return {
    async getFile(path: string, ref: string) {
      return getFile(config, path, ref);
    },
    async createBranch(branchName: string, baseBranch: string) {
      const ref = await githubRequest<{ object: { sha: string } }>(
        config,
        `/repos/${config.owner}/${config.repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
      );

      await githubRequest(
        config,
        `/repos/${config.owner}/${config.repo}/git/refs`,
        {
          method: 'POST',
          body: JSON.stringify({
            ref: `refs/heads/${branchName}`,
            sha: ref.object.sha,
          }),
        },
      );
    },
    async updateFile(path: string, content: string, branchName: string, message: string, sha: string) {
      await githubRequest(
        config,
        `/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            branch: branchName,
            content: toBase64(content),
            message,
            sha,
          }),
        },
      );
    },
    async createPullRequest(input: { head: string; base: string; title: string; body: string }) {
      return githubRequest<{ number: number; html_url: string }>(
        config,
        `/repos/${config.owner}/${config.repo}/pulls`,
        {
          method: 'POST',
          body: JSON.stringify({
            base: input.base,
            body: input.body,
            head: input.head,
            title: input.title,
          }),
        },
      ).then((pullRequest) => ({
        number: pullRequest.number,
        url: pullRequest.html_url,
      }));
    },
  };
}

export async function attemptAutoRemediation(input: {
  event: SentryEvent;
  severity: RankSeverityResult;
  investigation: InvestigationResult;
  errorMessage: string;
}, options: {
  github?: GitHubRemediationConfig;
  adapter?: GitHubRemediationAdapter;
} = {}): Promise<RemediationOutcome> {
  const decision = detectRemediationDecision({
    culprit: input.event.culprit,
    errorMessage: input.errorMessage,
    findings: input.investigation.findings,
    severity: input.severity.businessSeverity,
    title: input.event.title,
  });

  if (!decision.eligible) {
    return {
      status: 'not-applicable',
      decision,
      pattern: decision.pattern,
      reason: decision.reason,
    };
  }

  const targetFile = input.investigation.affectedFiles[0] ?? input.event.culprit;
  if (!targetFile) {
    return {
      status: 'skipped',
      decision,
      pattern: decision.pattern,
      reason: 'No target file was available for remediation.',
    };
  }

  if (!options.github && !options.adapter) {
    return {
      status: 'skipped',
      decision,
      pattern: decision.pattern,
      reason: 'GitHub configuration is missing, so auto-remediation was skipped.',
      targetFile,
    };
  }

  const github = options.adapter ?? createGitHubRemediationAdapter({
    ...options.github,
    baseBranch: options.github?.baseBranch ?? 'main',
    apiBaseUrl: options.github?.apiBaseUrl,
    owner: options.github!.owner,
    repo: options.github!.repo,
    token: options.github!.token,
  });
  const baseBranch = options.github?.baseBranch ?? 'main';

  if (!decision.property) {
    return {
      status: 'failed',
      decision,
      pattern: decision.pattern,
      reason: 'The remediation template did not include a property token to patch.',
      targetFile,
    };
  }

  let file;
  try {
    file = await github.getFile(targetFile, baseBranch);
  } catch (error) {
    return {
      status: 'failed',
      decision,
      pattern: decision.pattern,
      reason: error instanceof Error ? error.message : 'Unable to fetch the target file from GitHub.',
      targetFile,
    };
  }

  const updatedContent = applyNullGuardPatch(file.content, decision.property);
  if (!updatedContent) {
    return {
      status: 'failed',
      decision,
      pattern: decision.pattern,
      reason: `Could not find a direct access to ${decision.property} that could be patched safely.`,
      targetFile,
    };
  }

  const branchName = buildRemediationBranchName(input.event.id, decision.pattern);
  const candidate: RemediationCandidateFix = {
    branchName,
    files: [{ path: targetFile, content: updatedContent }],
    pattern: decision.pattern,
    pullRequestBody: [
      `This PR was generated from Sentry event ${input.event.id}.`,
      '',
      `Triage severity: ${input.severity.businessSeverity}`,
      `Triage rationale: ${input.severity.rationale}`,
      `Remediation pattern: ${decision.pattern}`,
      `Remediation reason: ${decision.reason}`,
      `Target file: ${targetFile}`,
      '',
      'Human review is still required before merge.',
    ].join('\n'),
    pullRequestTitle: `[auto-remediate] ${input.event.title}`,
    reason: decision.reason,
    targetFile,
  };

  await github.createBranch(candidate.branchName, baseBranch);
  await github.updateFile(targetFile, candidate.files[0].content, candidate.branchName, `Apply ${decision.pattern} remediation for ${input.event.id}`, file.sha);

  const pullRequest = await github.createPullRequest({
    base: baseBranch,
    body: candidate.pullRequestBody,
    head: candidate.branchName,
    title: candidate.pullRequestTitle,
  });

  return {
    status: 'pr-created',
    decision,
    pattern: decision.pattern,
    reason: `Created GitHub pull request #${pullRequest.number}.`,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    targetFile,
  };
}
