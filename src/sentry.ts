import type { EventSignals } from './types';

export interface SentryClientConfig {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SentryIssueStats {
  eventCount: number;
  userCount: number;
}

// Escalation thresholds for v4 signals
export const EVENT_RATE_THRESHOLD = 10; // events per time window
export const TIME_WINDOW_SECONDS = 3600; // 60 minutes
export const USER_COUNT_THRESHOLD = 100; // affected users

export class SentryClient {
  private token?: string;
  private baseUrl: string;
  private fetch: typeof fetch;

  constructor(config: SentryClientConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl ?? 'https://sentry.io/api/0';
    this.fetch = config.fetchImpl ?? fetch;
  }

  /**
   * Fetch issue statistics from Sentry API.
   * Returns event count and affected user count for an issue.
   */
  async fetchIssueStats(org: string, project: string, issueId: string): Promise<SentryIssueStats | null> {
    if (!this.token) {
      return null; // No credentials, skip signal fetching
    }

    try {
      const url = `${this.baseUrl}/projects/${org}/${project}/issues/${issueId}/`;
      const response = await this.fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error(`Sentry API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;

      // Extract stats from Sentry API response
      // stats field contains times_seen (event count) and userCount (unique users affected)
      const stats = data.stats as Record<string, unknown> | undefined;
      const userCount = data.userCount as number | undefined;

      if (stats && typeof stats === 'object') {
        const timesSeen = (stats as Record<string, unknown>)['24h'] as Array<[number, number]> | undefined;
        if (Array.isArray(timesSeen)) {
          // Sum up all events in the 24h period
          const eventCount = timesSeen.reduce((sum, [, count]) => sum + count, 0);
          return {
            eventCount,
            userCount: userCount ?? 0,
          };
        }
      }

      return {
        eventCount: (data.numComments as number) ?? 0,
        userCount: userCount ?? 0,
      };
    } catch (error) {
      console.error('Failed to fetch Sentry issue stats:', error);
      return null;
    }
  }

  /**
   * Determine if event signals should trigger escalation.
   * Returns signals and escalation reason if applicable.
   */
  determineEscalation(stats: SentryIssueStats | null): EventSignals {
    if (!stats) {
      return {}; // No signals if fetch failed
    }

    const escalationReason =
      stats.eventCount > EVENT_RATE_THRESHOLD
        ? 'high_frequency'
        : stats.userCount > USER_COUNT_THRESHOLD
          ? 'high_user_impact'
          : null;

    return {
      eventRate: stats.eventCount,
      affectedUserCount: stats.userCount,
      escalationReason: escalationReason,
    };
  }
}
