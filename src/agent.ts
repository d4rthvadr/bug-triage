import { investigateCodebase, rankSeverity } from './tools';
import type {
  AlertEventPayload,
  InvestigationResult,
  RankSeverityResult,
} from './types';

export type AiLike = {
  run: (
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    inputs: AiTextGenerationInput,
    options?: AiOptions,
  ) => Promise<AiTextGenerationOutput>;
};

function extractResponseText(response: AiTextGenerationOutput): string | undefined {
  if (typeof response.response === 'string' && response.response.trim()) {
    return response.response;
  }
  return undefined;
}

function formatReport(event: AlertEventPayload['data']['event'], severity: RankSeverityResult, investigation: InvestigationResult, reportText: string): string {
  const lines = [
    `Event ID: ${event.id}`,
    `Title: ${event.title}`,
    `Project: ${event.project}`,
    `Level: ${event.level}`,
    '',
    `Severity: ${severity.businessSeverity}`,
    `Reasoning: ${severity.rationale}`,
    `Affected files: ${investigation.affectedFiles.join(', ') || 'none identified'}`,
    `Suggested owner: ${investigation.suggestedOwner}`,
    '',
    'Final report:',
    reportText,
  ];

  return lines.join('\n');
}

export async function runTriageAgent(payload: AlertEventPayload, ai: AiLike): Promise<string> {
  const event = payload.data.event;
  const severity = rankSeverity({
    level: event.level,
    project: event.project,
    culprit: event.culprit,
  });
  const investigation = investigateCodebase({
    culprit: event.culprit,
    errorMessage: event.exception?.values?.[0]?.value ?? event.title,
    stackFrames: event.exception?.values?.[0]?.stacktrace?.frames ?? [],
  });

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
    `Suggested owner: ${investigation.suggestedOwner}`,
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

  const report = formatReport(event, severity, investigation, finalReportText);
  console.log(report);
  return finalReportText;
}
