# GitHub-backed lookup setup

Use this when you want `investigateCodebase` to query a real repository instead of the v1 mock.

The Worker uses `@octokit/rest` under the hood, so this setup only needs the token and repo mapping — the SDK handles the GitHub API calls.

## Configure environment

Set these values with Wrangler:

```bash
wrangler secret put PROJECT_REPOSITORY_MAP
wrangler secret put GITHUB_TOKEN
```

Optional:

```bash
wrangler secret put GITHUB_API_BASE_URL
```

## Project map format

`PROJECT_REPOSITORY_MAP` is JSON that maps a Sentry project name to a GitHub repo:

```json
{
  "checkout-api": {
    "owner": "acme",
    "repo": "checkout-api"
  }
}
```

## Behavior

When a triggered Sentry event arrives, the Worker:

1. looks up the repo for `event.project`
2. searches GitHub code for culprit terms
3. fetches recent commits for affected files
4. checks `CODEOWNERS`
5. returns `affectedFiles` and `suggestedOwner`

If no mapping exists for the project, the GitHub-backed lookup path is skipped by configuration and the request fails fast in the investigation step.
