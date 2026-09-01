# Spec: Triage Agent — v3 Auto-Remediation

## Problem Statement

v2 makes Sentry triage operationally useful: the agent can inspect real repository context, route alerts, and persist an audit trail. But the output still stops at triage. For a subset of well-understood, low-risk failures, the system should do the next useful thing automatically: propose a fix, package the context, and open a pull request for human review.

Without that step, the agent can explain the problem but cannot reduce the actual repair work for routine bugs.

## Solution

v3 adds an auto-remediation branch for recognised error patterns. When the alert is low risk and matches a known fixable pattern, the agent generates a candidate patch, opens a GitHub PR, and includes the triage report as PR context. High-severity alerts still follow the existing escalation path and do not auto-fix.

## Goals

- Generate candidate fixes for recognised, low-risk alert patterns
- Open a GitHub PR with the fix and triage context
- Keep the decision to auto-fix deterministic and auditable
- Preserve the existing v2 triage, routing, and persistence flow
- Avoid auto-remediation for high-severity incidents

## Non-Goals

- Broad incident automation
- Multi-source ingestion
- Learning-based severity tuning
- Deduplication or rate-based suppression
- Replacing human review for auto-generated fixes

## User Stories

1. As an on-call engineer, I want known low-risk errors to produce a candidate fix automatically, so that routine bugs do not require manual patch creation.
2. As a reviewer, I want the PR to include the triage report and reasoning, so that I can evaluate the fix in context.
3. As a platform owner, I want only recognised P2/P3 patterns to auto-remediate, so that the system does not make risky changes during incidents.
4. As a developer, I want the remediation step to reuse the same agent context and repository lookup data, so that it stays consistent with triage.
5. As an engineering manager, I want every auto-generated PR to be attributable to a specific alert, so that the repair trail remains auditable.

## Functional Requirements

### 1. Recognised Pattern Detection

The agent must decide whether an alert is eligible for auto-remediation using explicit rules, not hidden model judgment.

Eligibility rules:

- only P2 or P3 alerts may auto-remediate
- P0 and P1 alerts must skip fix generation and escalate only
- the alert must match a recognised pattern
- the matching pattern must map to a known remediation template or patch strategy

The recognition layer should be deterministic and reviewable in source control.

### 2. Candidate Fix Generation

For eligible alerts, the agent generates a candidate fix using the repository context gathered during triage.

The fix generation step should:

- use the affected files and findings from investigation
- produce a minimal patch
- avoid unrelated refactors
- include an explanation of the change
- fail closed if the patch cannot be derived confidently

If fix generation fails, the system should still emit the triage report and route normally.

### 3. GitHub PR Creation

When a candidate fix is produced, the system opens a GitHub pull request against the relevant repository.

The PR must include:

- a title that references the alert or error pattern
- the generated patch
- the triage report in the description
- the affected files and remediation rationale

The PR should be created only after the patch is generated successfully.

### 4. Escalation Rules

Auto-remediation must never run for:

- P0 alerts
- P1 alerts
- unrecognised patterns
- alerts with insufficient code context

These cases continue through the existing routing and persistence path only.

### 5. Audit Trail

The persisted triage record should capture whether auto-remediation was attempted and whether a PR was created.

Minimum additional fields:

- remediationEligible
- remediationStatus
- remediationPattern
- pullRequestUrl
- pullRequestNumber

## System Architecture

```text
Sentry
  │  POST /webhook/sentry
  ▼
Cloudflare Worker
  ├── Verify HMAC-SHA256 signature
  ├── Parse payload
  └── Agent loop
        ├── rankSeverity (deterministic)
        ├── investigateCodebase (GitHub-backed)
        ├── detectRemediationPattern (deterministic)
        ├── generateCandidateFix
        ├── open GitHub PR
        └── persist + route triage result
```

The remediation branch is an extension of the existing triage pipeline, not a separate system.

## Implementation Decisions

### Dependency Order

1. `src/types.ts` — shared domain types for remediation eligibility and PR metadata
2. `src/tools.ts` — deterministic pattern detection and candidate-fix helpers
3. `src/remediation.ts` — patch generation and GitHub PR creation boundary
4. `src/agent.ts` — orchestration of triage vs remediation branches
5. `src/index.ts` — webhook entrypoint and async execution

### Pattern Detection

Pattern detection should be a deterministic mapping from alert features to remediation templates.

Examples of eligible templates:

- missing null/undefined guard
- incorrect feature-flag branch
- stale API contract field name
- known safe retry/backoff adjustment

The exact template set should be intentionally small in v3.

### Candidate Fix Policy

The generated patch must be conservative:

- prefer single-file edits
- avoid schema or migration changes unless explicitly covered by the template
- avoid public API changes
- avoid sweeping refactors
- never mutate unrelated files

If the patch cannot be kept minimal, the system should stop and escalate instead of forcing an unsafe fix.

### GitHub PR Contract

PR creation should be explicit and structured:

- title: short summary of the bug pattern
- body: triage report, remediation rationale, and verification notes
- head branch: generated from the worker or a dedicated automation branch
- base branch: repository default or configured release branch

The PR description should make it obvious that a human review is still required.

## Testing Decisions

### What to test

1. P0/P1 alerts never enter the remediation branch
2. recognised P2/P3 patterns produce a remediation attempt
3. unrecognised patterns skip remediation cleanly
4. a successful candidate fix opens a GitHub PR
5. PR metadata includes the triage context
6. failed patch generation falls back to triage-only behaviour
7. persisted records capture remediation status

### Mocking discipline

Tests should use fake GitHub adapters and deterministic remediation templates. No live GitHub API calls, no live model calls, and no dependence on network state.

## Out of Scope

- Full autonomous code repair for arbitrary alerts
- Auto-merging remediation PRs
- Multi-source ingestion
- Learning from historical fixes
- More advanced tuning or deduplication
- Slack/PagerDuty changes beyond existing v2 routing

## Success Criteria

v3 is successful when:

- at least one recognised low-risk pattern can produce a candidate fix end-to-end
- the system skips auto-remediation for high-severity alerts
- every auto-generated PR is linked back to the originating alert
- human reviewers can inspect the triage report alongside the proposed fix

## Risks and Constraints

- A bad remediation template could introduce unsafe code changes
- GitHub PR creation adds operational complexity and token handling requirements
- Over-expanding the pattern set would blur v3 into a generic fixer
- The system must remain fail-closed when it lacks enough context to patch safely

## Open Questions

1. Which remediation templates should be included in the initial v3 set?
2. Should PRs target the default branch or a release branch by default?
3. Should the system push remediation branches directly, or create them through a dedicated GitHub app?
4. Do we require a verification step before PR creation, or only human review?
5. Should unsuccessful remediation attempts be surfaced in Slack or only persisted?

## Acceptance Summary

v3 turns the triage agent from a decision-making assistant into a repair assistant for a small, safe set of known problems. It keeps the deterministic severity model and v2 operational plumbing intact while adding a narrowly scoped remediation path that still depends on human review.
