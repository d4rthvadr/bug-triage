export type BusinessSeverity = 'P0' | 'P1' | 'P2' | 'P3';

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
}

export interface InvestigationResult {
  findings: string[];
  affectedFiles: string[];
  suggestedOwner: string;
}
