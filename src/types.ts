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

export interface EventSignals {
  eventRate?: number; // events in the time window
  affectedUserCount?: number; // users impacted by this issue
  escalationReason?: 'high_frequency' | 'high_user_impact' | null;
}

export interface RankSeverityInput {
  level: string;
  project: string;
  culprit: string;
  signals?: EventSignals;
}

export interface RankSeverityResult {
  businessSeverity: BusinessSeverity;
  rationale: string;
  escalationReason?: string;
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
  eventRate?: number;
  affectedUserCount?: number;
  escalationReason?: string;
  duplicateOf?: string; // links to original triage_id if duplicate
  resolvedAt?: string; // timestamp when marked resolved
  resolutionStatus?: 'open' | 'resolved' | 'suppressed';
}

export interface ResolutionEvent {
  eventId: string;
  project: string;
  title: string;
  status: 'resolved';
  dateResolved: string;
}

export interface NotificationResult {
  route: TriageRoute;
  status: NotificationStatus;
}
