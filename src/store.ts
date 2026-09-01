import type { PersistedTriageReport, TriageReport, BusinessSeverity, NotificationStatus } from './types';

export const DEDUP_WINDOW_MINUTES = 10; // Time window for deduplication

export interface TriageStore {
  save(report: PersistedTriageReport): Promise<void>;
  findRecentDuplicate(culprit: string, project: string): Promise<PersistedTriageReport | null>;
  updateForDuplicate(triageId: string, duplicateEventId: string): Promise<void>;
}

export function createD1TriageStore(db: D1Database): TriageStore {
  return {
    async save(report: PersistedTriageReport): Promise<void> {
      await db
        .prepare(
          `INSERT OR IGNORE INTO triage_results
            (id, eventId, title, project, level, businessSeverity, culprit, affectedFiles, suggestedOwner, rationale, createdAt, notificationChannel, notificationStatus, rawPayload, eventRate, affectedUserCount, escalationReason, duplicateOf, resolutionStatus)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          report.id,
          report.eventId,
          report.title,
          report.project,
          report.level,
          report.businessSeverity,
          report.culprit,
          JSON.stringify(report.affectedFiles),
          report.suggestedOwner ?? null,
          report.rationale,
          report.createdAt,
          report.route.channel,
          report.notificationStatus,
          report.rawPayload ?? null,
          report.eventRate ?? null,
          report.affectedUserCount ?? null,
          report.escalationReason ?? null,
          report.duplicateOf ?? null,
          report.resolutionStatus ?? 'open',
        )
        .run();
    },

    async findRecentDuplicate(culprit: string, project: string): Promise<PersistedTriageReport | null> {
      const tenMinutesAgo = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000).toISOString();

      const result = await db
        .prepare(
          `SELECT id, eventId, title, project, level, businessSeverity, culprit, affectedFiles, suggestedOwner, rationale, createdAt, notificationChannel, notificationStatus, rawPayload, eventRate, affectedUserCount, escalationReason, duplicateOf, resolutionStatus
         FROM triage_results
         WHERE culprit = ? AND project = ? AND createdAt > ? AND resolutionStatus = 'open'
         ORDER BY createdAt DESC
         LIMIT 1`,
        )
        .bind(culprit, project, tenMinutesAgo)
        .first<{
          id: string;
          eventId: string;
          title: string;
          project: string;
          level: string;
          businessSeverity: string;
          culprit: string;
          affectedFiles: string;
          suggestedOwner?: string;
          rationale: string;
          createdAt: string;
          notificationChannel: string;
          notificationStatus: string;
          rawPayload?: string;
          eventRate?: number;
          affectedUserCount?: number;
          escalationReason?: string;
          duplicateOf?: string;
          resolutionStatus: string;
        }>();

      if (!result) return null;

      return {
        id: result.id,
        eventId: result.eventId,
        title: result.title,
        project: result.project,
        level: result.level,
        culprit: result.culprit,
        businessSeverity: result.businessSeverity as BusinessSeverity,
        rationale: result.rationale,
        findings: [],
        affectedFiles: result.affectedFiles ? JSON.parse(result.affectedFiles) : [],
        suggestedOwner: result.suggestedOwner || undefined,
        recommendedAction: '',
        route: {
          channel: (result.notificationChannel as 'slack' | 'pagerduty' | 'log') || 'log',
          destination: result.project,
          status: (result.notificationStatus as NotificationStatus) || 'queued',
        },
        reportText: '',
        notificationStatus: (result.notificationStatus as NotificationStatus) || 'queued',
        createdAt: result.createdAt,
        rawPayload: result.rawPayload || undefined,
        eventRate: result.eventRate || undefined,
        affectedUserCount: result.affectedUserCount || undefined,
        escalationReason: result.escalationReason || undefined,
        duplicateOf: result.duplicateOf || undefined,
        resolutionStatus: (result.resolutionStatus as 'open' | 'resolved' | 'suppressed') || 'open',
      };
    },

    async updateForDuplicate(triageId: string, duplicateEventId: string): Promise<void> {
      const now = new Date().toISOString();
      await db
        .prepare(
          `UPDATE triage_results 
         SET lastEventAt = ?, notificationStatus = 'suppressed'
         WHERE id = ?`,
        )
        .bind(now, triageId)
        .run();
    },
  };
}

export function createMemoryTriageStore(): TriageStore {
  const saved = new Map<string, PersistedTriageReport>();
  return {
    async save(report: PersistedTriageReport): Promise<void> {
      saved.set(report.id, report);
    },

    async findRecentDuplicate(culprit: string, project: string): Promise<PersistedTriageReport | null> {
      const tenMinutesAgo = Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000;
      
      for (const report of saved.values()) {
        const createdTime = new Date(report.createdAt).getTime();
        if (
          report.culprit === culprit &&
          report.project === project &&
          createdTime > tenMinutesAgo &&
          report.resolutionStatus === 'open'
        ) {
          return report;
        }
      }
      return null;
    },

    async updateForDuplicate(triageId: string): Promise<void> {
      const report = Array.from(saved.values()).find(r => r.id === triageId);
      if (report) {
        report.resolutionStatus = 'suppressed';
      }
    },
  };
}

export function toPersistedTriageReport(report: TriageReport, rawPayload?: string): PersistedTriageReport {
  return {
    id: crypto.randomUUID(),
    ...report,
    rawPayload,
  };
}
