CREATE TABLE IF NOT EXISTS triage_results (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  level TEXT NOT NULL,
  businessSeverity TEXT NOT NULL,
  culprit TEXT,
  affectedFiles TEXT NOT NULL,
  suggestedOwner TEXT,
  rationale TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  notificationChannel TEXT,
  notificationStatus TEXT,
  rawPayload TEXT
);
