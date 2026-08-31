import type { GitHubClientConfig, RepositoryRef } from './types';

interface GitHubSearchCodeItem {
  name?: string;
  path?: string;
}

interface GitHubCommitItem {
  sha: string;
  commit: {
    author?: {
      name?: string;
    };
  };
  author?: {
    login?: string;
  };
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function joinBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
}

async function readText(response: Response): Promise<string> {
  return response.text();
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, token?: string): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function requestOptionalText(fetchImpl: typeof fetch, url: string, token?: string): Promise<string | undefined> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`GitHub request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return readText(response);
}

export interface GitHubClient {
  searchCode(repository: RepositoryRef, query: string): Promise<GitHubSearchCodeItem[]>;
  listCommits(repository: RepositoryRef, path: string): Promise<GitHubCommitItem[]>;
  getFileText(repository: RepositoryRef, path: string): Promise<string | undefined>;
  getCodeowners(repository: RepositoryRef): Promise<string | undefined>;
}

export function createGitHubClient(config: GitHubClientConfig = {}): GitHubClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = joinBaseUrl(config.baseUrl);

  return {
    async searchCode(repository: RepositoryRef, query: string): Promise<GitHubSearchCodeItem[]> {
      const url = new URL(`${baseUrl}/search/code`);
      url.searchParams.set('q', `repo:${repository.owner}/${repository.repo} ${query}`);
      const response = await requestJson<{ items?: GitHubSearchCodeItem[] }>(fetchImpl, url.toString(), config.token);
      return response.items ?? [];
    },

    async listCommits(repository: RepositoryRef, path: string): Promise<GitHubCommitItem[]> {
      const url = new URL(`${baseUrl}/repos/${repository.owner}/${repository.repo}/commits`);
      url.searchParams.set('path', path);
      return requestJson<GitHubCommitItem[]>(fetchImpl, url.toString(), config.token);
    },

    async getFileText(repository: RepositoryRef, path: string): Promise<string | undefined> {
      const url = `${baseUrl}/repos/${repository.owner}/${repository.repo}/contents/${encodePath(path)}`;
      return requestOptionalText(fetchImpl, url, config.token);
    },

    async getCodeowners(repository: RepositoryRef): Promise<string | undefined> {
      const candidates = ['.github/CODEOWNERS', 'CODEOWNERS'];
      for (const candidate of candidates) {
        const text = await requestOptionalText(
          fetchImpl,
          `${baseUrl}/repos/${repository.owner}/${repository.repo}/contents/${encodePath(candidate)}`,
          config.token,
        );
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
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
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
