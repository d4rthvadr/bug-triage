export type BusinessSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export type NotificationChannel = 'pagerduty' | 'slack' | 'log';
export type NotificationStatus = 'queued' | 'sent' | 'skipped' | 'not_configured' | 'failed';

export interface RepositoryRef {
  owner: string;
  repo: string;
  branch?: string;
}

export interface SentryStackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
}

export interface SentryExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: SentryStackFrame[];
  };
}

export interface SentryEvent {
  id: string;
  title: string;
  culprit: string;
  level: string;
  project: string;
  exception?: {
    values?: SentryExceptionValue[];
  };
}

export interface AlertEventPayload {
  action: string;
  data: {
    event: SentryEvent;
  };
}

export interface RankSeverityInput {
  level: string;
  project: string;
  culprit: string;
}

export interface RankSeverityResult {
  businessSeverity: BusinessSeverity;
  rationale: string;
}

export interface InvestigateCodebaseInput {
  culprit: string;
  errorMessage: string;
  stackFrames: SentryStackFrame[];
  project: string;
}

export interface InvestigationResult {
  findings: string[];
  affectedFiles: string[];
  suggestedOwner?: string;
}

export interface GitHubRepositoryMapping {
  project: string;
  repository: RepositoryRef;
}

export interface GitHubClientConfig {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface InvestigationDependencies {
  github?: GitHubClientConfig;
  repositoryMapping?: Record<string, RepositoryRef>;
}

export interface TriageRoute {
  channel: NotificationChannel;
  destination: string;
  status: NotificationStatus;
}

export interface TriageReport {
  eventId: string;
  title: string;
  project: string;
  level: string;
  culprit: string;
  businessSeverity: BusinessSeverity;
  rationale: string;
  findings: string[];
  affectedFiles: string[];
  suggestedOwner?: string;
  recommendedAction: string;
  route: TriageRoute;
  reportText: string;
  notificationStatus: NotificationStatus;
  createdAt: string;
}

export interface PersistedTriageReport extends TriageReport {
  id: string;
  rawPayload?: string;
  remediationEligible: boolean;
  remediationStatus: RemediationOutcome['status'];
  remediationPattern: RemediationPattern;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
}

export interface NotificationResult {
  route: TriageRoute;
  status: NotificationStatus;
}

export type RemediationPattern = 'none' | 'missing-null-guard';

export interface RemediationDecision {
  eligible: boolean;
  pattern: RemediationPattern;
  reason: string;
  property?: string;
}

export interface RemediationCandidateFile {
  path: string;
  content: string;
}

export interface RemediationCandidateFix {
  pattern: RemediationPattern;
  reason: string;
  branchName: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  files: RemediationCandidateFile[];
  targetFile: string;
}

export interface RemediationOutcome {
  status: 'not-applicable' | 'skipped' | 'generated' | 'pr-created' | 'failed';
  decision: RemediationDecision;
  reason: string;
  pattern: RemediationPattern;
  targetFile?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}

export interface GitHubRemediationConfig {
  owner: string;
  repo: string;
  token: string;
  baseBranch?: string;
  apiBaseUrl?: string;
}

/**
 * Append-only audit trail record for a single triage event. Mirrors the v2
 * `triage_results` schema, extended with the v3 remediation audit fields.
 */
export interface TriageAuditRecord {
  id: string;
  eventId: string;
  title: string;
  project: string;
  level: string;
  businessSeverity: BusinessSeverity;
  culprit: string;
  affectedFiles: string[];
  suggestedOwner: string;
  rationale: string;
  createdAt: string;
  remediationEligible: boolean;
  remediationStatus: RemediationOutcome['status'];
  remediationPattern: RemediationPattern;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
}
