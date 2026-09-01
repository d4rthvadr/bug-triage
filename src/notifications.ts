import type { NotificationResult, TriageReport } from './types';

export interface NotificationDependencies {
  slackWebhookUrl?: string;
  pagerDutyWebhookUrl?: string;
  fetchImpl?: typeof fetch;
}

function routeDestination(report: TriageReport): TriageReport['route']['channel'] {
  switch (report.businessSeverity) {
    case 'P0':
      return 'pagerduty';
    case 'P1':
    case 'P2':
      return 'slack';
    default:
      return 'log';
  }
}

export function selectNotificationResult(report: TriageReport): NotificationResult {
  const channel = routeDestination(report);

  if (channel === 'pagerduty') {
    return {
      route: {
        channel,
        destination: report.businessSeverity,
        status: 'not_configured',
      },
      status: 'not_configured',
    };
  }

  if (channel === 'slack') {
    return {
      route: {
        channel,
        destination: report.project,
        status: 'queued',
      },
      status: 'queued',
    };
  }

  return {
    route: {
      channel,
      destination: 'console',
      status: 'skipped',
    },
    status: 'skipped',
  };
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deliverNotification(
  report: TriageReport,
  dependencies: NotificationDependencies,
): Promise<NotificationResult> {
  const selection = selectNotificationResult(report);
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  if (selection.route.channel === 'pagerduty') {
    if (!dependencies.pagerDutyWebhookUrl) {
      return {
        route: {
          ...selection.route,
          status: 'not_configured',
        },
        status: 'not_configured',
      };
    }

    const response = await postJson(fetchImpl, dependencies.pagerDutyWebhookUrl, report);
    return {
      route: {
        ...selection.route,
        status: response.ok ? 'sent' : 'failed',
      },
      status: response.ok ? 'sent' : 'failed',
    };
  }

  if (selection.route.channel === 'slack') {
    if (!dependencies.slackWebhookUrl) {
      return {
        route: {
          ...selection.route,
          status: 'not_configured',
        },
        status: 'not_configured',
      };
    }

    const response = await postJson(fetchImpl, dependencies.slackWebhookUrl, {
      text: `${report.businessSeverity} ${report.title}\n${report.reportText}`,
      triage: report,
    });

    return {
      route: {
        ...selection.route,
        status: response.ok ? 'sent' : 'failed',
      },
      status: response.ok ? 'sent' : 'failed',
    };
  }

  return selection;
}

export async function closeTicket(
  channel: 'slack' | 'pagerduty',
  eventId: string,
  reason: 'resolved' | 'duplicate',
  metadata?: {
    message?: string;
    slackWebhookUrl?: string;
    pagerDutyWebhookUrl?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const fetchImpl = metadata?.fetchImpl ?? fetch;

  if (channel === 'slack' && metadata?.slackWebhookUrl) {
    const closureText = reason === 'resolved' 
      ? `✅ This issue has been resolved in Sentry.\n${metadata.message || ''}`
      : `🔀 This alert was suppressed as a duplicate.`;

    try {
      await postJson(fetchImpl, metadata.slackWebhookUrl, {
        text: closureText,
        eventId,
        reason,
        resolvedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`Failed to send Slack closure for event ${eventId}:`, error);
    }
  }

  if (channel === 'pagerduty' && metadata?.pagerDutyWebhookUrl) {
    const closureText = reason === 'resolved' 
      ? `Issue resolved: ${metadata.message || eventId}`
      : `Incident suppressed as duplicate: ${eventId}`;

    try {
      await postJson(fetchImpl, metadata.pagerDutyWebhookUrl, {
        routing_key: 'pagerduty-key',
        event_action: 'resolve',
        dedup_key: eventId,
        payload: {
          summary: closureText,
          timestamp: new Date().toISOString(),
          severity: 'info',
          source: 'bug-triage-agent',
        },
      });
    } catch (error) {
      console.error(`Failed to send PagerDuty closure for event ${eventId}:`, error);
    }
  }
}
