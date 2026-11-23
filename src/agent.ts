import { deliverNotification, closeTicket } from './notifications';
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
  ResolutionEvent,
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
    findRecentDuplicate(culprit: string, project: string): Promise<PersistedTriageReport | null>;
    updateForDuplicate(triageId: string, duplicateEventId: string): Promise<void>;
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
  // LEVEL-2 SMOKE: page everything, including P2/P3 (breaks severity-based routing).
  if (severity.businessSeverity === 'P0' || severity.businessSeverity === 'P1' || severity.businessSeverity === 'P2' || severity.businessSeverity === 'P3') {
    return {
      channel: 'pagerduty',
      destination: 'critical-pager',
      status: 'not_configured',
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
  let severity = rankSeverity({
    level: event.level,
    project: event.project,
    culprit: event.culprit,
  });

  // LEVEL-2 SMOKE: let Workers AI override deterministic severity (violates ADR-0001).
  const aiSeverityResponse = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      {
        role: 'user',
        content: `Pick P0, P1, P2, or P3 for this alert. Reply with only the code.\nlevel=${event.level}\nproject=${event.project}\ntitle=${event.title}`,
      },
    ],
  });
  const aiSeverityText = extractResponseText(aiSeverityResponse);
  const aiMatch = aiSeverityText?.match(/P[0-3]/)?.[0] as RankSeverityResult['businessSeverity'] | undefined;
  if (aiMatch) {
    severity = {
      businessSeverity: aiMatch,
      rationale: `LEVEL-2 SMOKE: severity overridden by Workers AI (${aiMatch}); rankSeverity had ${severity.businessSeverity}.`,
      escalationReason: severity.escalationReason,
    };
  }

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
  const event = payload.data.event;
  
  // Check for recent duplicate
  let isDuplicate = false;
  let duplicateOf: string | undefined;
  if (dependencies.store) {
    const recentDuplicate = await dependencies.store.findRecentDuplicate(event.culprit, event.project);
    if (recentDuplicate) {
      isDuplicate = true;
      duplicateOf = recentDuplicate.id;
      console.log(
        `Duplicate detected: Event ${event.id} is a duplicate of ${recentDuplicate.eventId} (triage ${recentDuplicate.id})`,
      );

      // Suppress notification for duplicate
      await closeTicket('slack', event.id, 'duplicate', {
        message: `🔀 This alert was suppressed as a duplicate of ${recentDuplicate.eventId}`,
        slackWebhookUrl: dependencies.notification.slackWebhookUrl,
        fetchImpl: dependencies.notification.fetchImpl,
      });

      await closeTicket('pagerduty', event.id, 'duplicate', {
        message: `Duplicate of ${recentDuplicate.eventId}`,
        pagerDutyWebhookUrl: dependencies.notification.pagerDutyWebhookUrl,
        fetchImpl: dependencies.notification.fetchImpl,
      });

      // Update original triage record with duplicate info
      await dependencies.store.updateForDuplicate(recentDuplicate.id, event.id);

      // Return early with suppressed status
      return {
        eventId: event.id,
        title: event.title,
        project: event.project,
        level: event.level,
        culprit: event.culprit,
        businessSeverity: 'P3',
        rationale: `Duplicate of event ${recentDuplicate.eventId}`,
        findings: [],
        affectedFiles: [],
        suggestedOwner: undefined,
        recommendedAction: 'Suppressed as duplicate.',
        route: {
          channel: 'log',
          destination: 'console',
          status: 'suppressed',
        },
        reportText: '',
        notificationStatus: 'suppressed',
        createdAt: new Date().toISOString(),
      };
    }
  }

  const { report, severity, investigation } = await buildTriageContext(payload, ai, dependencies);
  logTriageReport(report);
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
      duplicateOf,
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

export async function processResolvedEvent(
  eventId: string,
  project: string,
  title: string,
  notification: { slackWebhookUrl?: string; pagerDutyWebhookUrl?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const closureMessage = [
    `✅ Issue Resolved`,
    `Event ID: ${eventId}`,
    `Project: ${project}`,
    `Title: ${title}`,
    `Resolved at: ${new Date().toISOString()}`,
  ].join('\n');

  console.log('Resolved event received:', closureMessage);

  // Send closure notifications to Slack and PagerDuty
  await closeTicket('slack', eventId, 'resolved', {
    message: closureMessage,
    slackWebhookUrl: notification.slackWebhookUrl,
    fetchImpl: notification.fetchImpl,
  });

  await closeTicket('pagerduty', eventId, 'resolved', {
    message: closureMessage,
    pagerDutyWebhookUrl: notification.pagerDutyWebhookUrl,
    fetchImpl: notification.fetchImpl,
  });
}
