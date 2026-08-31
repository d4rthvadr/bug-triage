import { Octokit } from '@octokit/rest';

import type { GitHubClientConfig, RepositoryRef } from './types';

interface GitHubSearchCodeItem {
  path?: string;
}

interface GitHubCommitItem {
  author?: {
    login?: string;
  };
  commit: {
    author?: {
      name?: string;
    };
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
}

function createOctokit(config: GitHubClientConfig): Octokit {
  return new Octokit({
    auth: config.token,
    baseUrl: normalizeBaseUrl(config.baseUrl),
    ...(config.fetchImpl
      ? {
          request: {
            fetch: config.fetchImpl,
          },
        }
      : {}),
  });
}

function parseContentString(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data;
  }

  return undefined;
}

async function readRawFile(
  octokit: Octokit,
  repository: RepositoryRef,
  path: string,
): Promise<string | undefined> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repository.owner,
      repo: repository.repo,
      path,
      mediaType: {
        format: 'raw',
      },
    });

    return parseContentString(response.data);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number' &&
      (error as { status?: number }).status === 404
    ) {
      return undefined;
    }

    throw error;
  }
}

export interface GitHubClient {
  searchCode(repository: RepositoryRef, query: string): Promise<GitHubSearchCodeItem[]>;
  listCommits(repository: RepositoryRef, path: string): Promise<GitHubCommitItem[]>;
  getFileText(repository: RepositoryRef, path: string): Promise<string | undefined>;
  getCodeowners(repository: RepositoryRef): Promise<string | undefined>;
}

export function createGitHubClient(config: GitHubClientConfig = {}): GitHubClient {
  const octokit = createOctokit(config);

  return {
    async searchCode(repository: RepositoryRef, query: string): Promise<GitHubSearchCodeItem[]> {
      const response = await octokit.rest.search.code({
        q: `repo:${repository.owner}/${repository.repo} ${query}`,
        per_page: 10,
      });

      return response.data.items.map((item) => ({ path: item.path ?? undefined }));
    },

    async listCommits(repository: RepositoryRef, path: string): Promise<GitHubCommitItem[]> {
      const response = await octokit.rest.repos.listCommits({
        owner: repository.owner,
        repo: repository.repo,
        path,
        per_page: 10,
      });

      return response.data.map((commit) => ({
        author: {
          login: commit.author?.login,
        },
        commit: {
          author: {
            name: commit.commit.author?.name,
          },
        },
      }));
    },

    async getFileText(repository: RepositoryRef, path: string): Promise<string | undefined> {
      return readRawFile(octokit, repository, path);
    },

    async getCodeowners(repository: RepositoryRef): Promise<string | undefined> {
      for (const candidate of ['.github/CODEOWNERS', 'CODEOWNERS']) {
        const text = await readRawFile(octokit, repository, candidate);
        if (text) {
          return text;
        }
      }

      return undefined;
    },
  };
}

export function parseCodeowners(text: string): Array<{ pattern: string; owners: string[] }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern, owners };
    });
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`);
}

export function findCodeownerForPath(path: string, codeownersText: string): string | undefined {
  const entries = parseCodeowners(codeownersText);
  for (const entry of entries) {
    if (entry.owners.length === 0) {
      continue;
    }

    if (wildcardToRegExp(entry.pattern).test(path)) {
      return entry.owners[0];
    }
  }

  return undefined;
}
