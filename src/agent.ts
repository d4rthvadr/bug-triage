import { investigateCodebase, rankSeverity } from './tools';
import type {
  AlertEventPayload,
  InvestigationResult,
  RankSeverityResult,
} from './types';

type AiRunResponse = {
  result?: {
    response?: string;
  };
  response?: string;
  choices?: Array<{ text?: string; message?: { content?: string } }>;
};

export type AiLike = {
  run: (model: string, args: Record<string, unknown>) => Promise<AiRunResponse>;
};

function extractResponseText(response: AiRunResponse | undefined): string | undefined {
  const resultText = response?.result?.response;
  if (typeof resultText === 'string' && resultText.trim()) return resultText;

  const legacyText = response?.response;
  if (typeof legacyText === 'string' && legacyText.trim()) return legacyText;

  const choiceText = response?.choices?.[0]?.text;
  if (typeof choiceText === 'string' && choiceText.trim()) return choiceText;

  const firstChoice = response?.choices?.[0]?.message;
  const content = firstChoice?.content;
  if (typeof content === 'string' && content.trim()) return content;

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
