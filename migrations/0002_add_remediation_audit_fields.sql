ALTER TABLE triage_results ADD COLUMN remediationEligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE triage_results ADD COLUMN remediationStatus TEXT NOT NULL DEFAULT 'not-applicable';
ALTER TABLE triage_results ADD COLUMN remediationPattern TEXT NOT NULL DEFAULT 'none';
ALTER TABLE triage_results ADD COLUMN pullRequestUrl TEXT;
ALTER TABLE triage_results ADD COLUMN pullRequestNumber INTEGER;
