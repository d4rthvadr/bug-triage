import type { InvestigationDependencies, RepositoryRef } from './types';

export interface EnvConfig {
  GITHUB_TOKEN?: string;
  GITHUB_API_BASE_URL?: string;
  PROJECT_REPOSITORY_MAP?: string;
  SLACK_WEBHOOK_URL?: string;
  PAGERDUTY_WEBHOOK_URL?: string;
}

function normalizeProjectName(project: string): string {
  return project.trim().toLowerCase();
}

export function parseRepositoryMapping(raw: string | undefined): Record<string, RepositoryRef> {
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as Record<string, string | RepositoryRef>;
  const entries = Object.entries(parsed).map(([project, value]) => {
    if (typeof value === 'string') {
      const [owner, repo] = value.split('/');
      if (!owner || !repo) {
        throw new Error(`Invalid repository mapping for project "${project}". Expected "owner/repo".`);
      }

      return [normalizeProjectName(project), { owner, repo } satisfies RepositoryRef] as const;
    }

    if (!value.owner || !value.repo) {
      throw new Error(`Invalid repository mapping for project "${project}". Expected owner and repo fields.`);
    }

    return [normalizeProjectName(project), { owner: value.owner, repo: value.repo, branch: value.branch }] as const;
  });

  return Object.fromEntries(entries);
}

export function buildInvestigationDependencies(env: EnvConfig): InvestigationDependencies {
  return {
    github: {
      baseUrl: env.GITHUB_API_BASE_URL,
      token: env.GITHUB_TOKEN,
    },
    repositoryMapping: parseRepositoryMapping(env.PROJECT_REPOSITORY_MAP),
  };
}

export function resolveRepository(project: string, mapping?: Record<string, RepositoryRef>): RepositoryRef | undefined {
  const key = normalizeProjectName(project);
  return mapping?.[key];
}

export function normalizeProjectKey(project: string): string {
  return normalizeProjectName(project);
}
