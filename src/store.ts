import type { PersistedTriageReport, RemediationOutcome, TriageReport } from './types';

export interface TriageStore {
  save(report: PersistedTriageReport): Promise<void>;
}

export function createD1TriageStore(db: D1Database): TriageStore {
  return {
    async save(report: PersistedTriageReport): Promise<void> {
      await db
        .prepare(
          `INSERT OR IGNORE INTO triage_results
            (id, eventId, title, project, level, businessSeverity, culprit, affectedFiles, suggestedOwner, rationale, createdAt, notificationChannel, notificationStatus, rawPayload, remediationEligible, remediationStatus, remediationPattern, pullRequestUrl, pullRequestNumber)
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
          report.remediationEligible ? 1 : 0,
          report.remediationStatus,
          report.remediationPattern,
          report.pullRequestUrl ?? null,
          report.pullRequestNumber ?? null,
        )
        .run();
    },
  };
}

export function createMemoryTriageStore(): TriageStore {
  const saved = new Set<string>();
  return {
    async save(report: PersistedTriageReport): Promise<void> {
      if (saved.has(report.eventId)) {
        return;
      }
      saved.add(report.eventId);
    },
  };
}

export function toPersistedTriageReport(
  report: TriageReport,
  remediation: RemediationOutcome,
  rawPayload?: string,
): PersistedTriageReport {
  return {
    id: crypto.randomUUID(),
    ...report,
    rawPayload,
    remediationEligible: remediation.decision.eligible,
    remediationStatus: remediation.status,
    remediationPattern: remediation.pattern,
    pullRequestUrl: remediation.pullRequestUrl,
    pullRequestNumber: remediation.pullRequestNumber,
  };
}
