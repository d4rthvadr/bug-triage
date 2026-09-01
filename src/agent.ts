import { deliverNotification } from './notifications';
import { resolveRepository } from './config';
import { attemptAutoRemediation, type GitHubRemediationAdapter } from './remediation';
import { toPersistedTriageReport } from './store';
import { investigateCodebase, rankSeverity } from './tools';
import type {
  AlertEventPayload,
  InvestigationDependencies,
  InvestigationResult,
  PersistedTriageReport,
  RankSeverityResult,
  TriageReport,
} from './types';

export type AiLike = {
  run: (
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    inputs: AiTextGenerationInput,
    options?: AiOptions,
  ) => Promise<AiTextGenerationOutput>;
};

export interface TriageRuntimeDependencies {
  investigation: InvestigationDependencies;
  notification: {
    slackWebhookUrl?: string;
    pagerDutyWebhookUrl?: string;
    fetchImpl?: typeof fetch;
  };
  remediation?: {
    token?: string;
    apiBaseUrl?: string;
    baseBranch?: string;
    adapter?: GitHubRemediationAdapter;
  };
  store?: {
    save(report: PersistedTriageReport): Promise<void>;
  };
  rawPayload?: string;
}

function extractResponseText(response: AiTextGenerationOutput): string | undefined {
  if (typeof response.response === 'string' && response.response.trim()) {
    return response.response;
  }
  return undefined;
}

function buildRecommendedAction(severity: RankSeverityResult): string {
  switch (severity.businessSeverity) {
    case 'P0':
      return 'Escalate immediately and page the owning team.';
    case 'P1':
      return 'Notify the owning team with code context and respond within the current shift.';
    case 'P2':
      return 'Queue for normal triage with the affected files and owner.';
    default:
      return 'Log and monitor without escalation.';
  }
}

function selectRoute(severity: RankSeverityResult, project: string): TriageReport['route'] {
  if (severity.businessSeverity === 'P0') {
    return {
      channel: 'pagerduty',
      destination: 'critical-pager',
      status: 'not_configured',
    };
  }

  if (severity.businessSeverity === 'P1' || severity.businessSeverity === 'P2') {
    return {
      channel: 'slack',
      destination: project,
      status: 'queued',
    };
  }

  return {
    channel: 'log',
    destination: 'console',
    status: 'skipped',
  };
}

function logTriageReport(report: TriageReport): void {
  console.log(
    [
      `Event ID: ${report.eventId}`,
      `Title: ${report.title}`,
      `Project: ${report.project}`,
      `Level: ${report.level}`,
      `Severity: ${report.businessSeverity}`,
      `Route: ${report.route.channel}:${report.route.destination}`,
      '',
      report.reportText,
    ].join('\n'),
  );
}

async function synthesizeReport(
  payload: AlertEventPayload,
  ai: AiLike,
  severity: RankSeverityResult,
  investigation: InvestigationResult,
): Promise<string> {
  const event = payload.data.event;
  const prompt = [
    'You are a triage assistant. Create a concise triage report from the provided deterministic analysis.',
    '',
    `Event ID: ${event.id}`,
    `Title: ${event.title}`,
    `Project: ${event.project}`,
    `Level: ${event.level}`,
    `Culprit: ${event.culprit}`,
    '',
    `Business severity: ${severity.businessSeverity}`,
    `Severity rationale: ${severity.rationale}`,
    `Affected files: ${investigation.affectedFiles.join(', ') || 'none identified'}`,
    `Suggested owner: ${investigation.suggestedOwner ?? 'unassigned'}`,
    `Findings: ${investigation.findings.join(' ')}`,
    '',
    'Return the report body only.',
  ].join('\n');

  const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    prompt,
    max_tokens: 1024,
  });
  const finalReportText = extractResponseText(response);
  if (!finalReportText) {
    throw new Error('Workers AI returned no triage report text.');
  }

  return finalReportText;
}

async function buildTriageContext(
  payload: AlertEventPayload,
  ai: AiLike,
  dependencies: TriageRuntimeDependencies,
): Promise<{
  report: TriageReport;
  severity: RankSeverityResult;
  investigation: InvestigationResult;
}> {
  const event = payload.data.event;
  const severity = rankSeverity({
    level: event.level,
    project: event.project,
    culprit: event.culprit,
  });
  const investigation = await investigateCodebase(
    {
      culprit: event.culprit,
      errorMessage: event.exception?.values?.[0]?.value ?? event.title,
      stackFrames: event.exception?.values?.[0]?.stacktrace?.frames ?? [],
      project: event.project,
    },
    dependencies.investigation,
  );
  const reportText = await synthesizeReport(payload, ai, severity, investigation);
  const route = selectRoute(severity, event.project);

  return {
    report: {
      eventId: event.id,
      title: event.title,
      project: event.project,
      level: event.level,
      culprit: event.culprit,
      businessSeverity: severity.businessSeverity,
      rationale: severity.rationale,
      findings: investigation.findings,
      affectedFiles: investigation.affectedFiles,
      suggestedOwner: investigation.suggestedOwner,
      recommendedAction: buildRecommendedAction(severity),
      route,
      reportText,
      notificationStatus: route.status,
      createdAt: new Date().toISOString(),
    },
    severity,
    investigation,
  };
}

export async function runTriageAgent(
  payload: AlertEventPayload,
  ai: AiLike,
  dependencies: TriageRuntimeDependencies,
): Promise<TriageReport> {
  const { report } = await buildTriageContext(payload, ai, dependencies);
  logTriageReport(report);
  return report;
}

export async function processTriggeredEvent(
  payload: AlertEventPayload,
  ai: AiLike,
  dependencies: TriageRuntimeDependencies,
): Promise<TriageReport> {
  const { report, severity, investigation } = await buildTriageContext(payload, ai, dependencies);
  logTriageReport(report);
  const event = payload.data.event;
  const repository = resolveRepository(event.project, dependencies.investigation.repositoryMapping);
  const remediation = await attemptAutoRemediation(
    {
      event,
      severity,
      investigation,
      errorMessage: event.exception?.values?.[0]?.value ?? event.title,
    },
    repository && dependencies.remediation?.token
      ? {
          github: {
            owner: repository.owner,
            repo: repository.repo,
            token: dependencies.remediation.token,
            baseBranch: repository.branch ?? dependencies.remediation.baseBranch,
            apiBaseUrl: dependencies.remediation.apiBaseUrl,
          },
          adapter: dependencies.remediation.adapter,
        }
      : {
          adapter: dependencies.remediation?.adapter,
        },
  );
  const notification = await deliverNotification(report, dependencies.notification);
  const persisted = toPersistedTriageReport(
    {
      ...report,
      route: notification.route,
      notificationStatus: notification.status,
    },
    remediation,
    dependencies.rawPayload,
  );

  if (dependencies.store) {
    await dependencies.store.save(persisted);
  }

  return {
    ...report,
    route: notification.route,
    notificationStatus: notification.status,
  };
}
