import { investigateCodebase, rankSeverity } from './tools';
import type {
  AlertEventPayload,
  BusinessSeverity,
  InvestigationResult,
  RankSeverityResult,
} from './types';

const MAX_ITERATIONS = 5;

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

type AiRunResponse = {
  result?: {
    tool_calls?: ToolCall[];
    response?: string;
  };
  tool_calls?: ToolCall[];
  response?: string;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
};

export type AiLike = {
  run: (model: string, args: Record<string, unknown>) => Promise<AiRunResponse>;
};

function extractToolCalls(response: AiRunResponse | undefined): ToolCall[] {
  const fromResult = response?.result?.tool_calls ?? [];
  if (fromResult.length > 0) return fromResult;

  const fromLegacy = response?.tool_calls ?? [];
  if (fromLegacy.length > 0) return fromLegacy;

  const firstChoice = response?.choices?.[0]?.message;
  if (firstChoice?.tool_calls && firstChoice.tool_calls.length > 0) {
    return firstChoice.tool_calls;
  }

  return [];
}

function extractResponseText(response: AiRunResponse | undefined): string | undefined {
  const resultText = response?.result?.response;
  if (typeof resultText === 'string' && resultText.trim()) return resultText;

  const legacyText = response?.response;
  if (typeof legacyText === 'string' && legacyText.trim()) return legacyText;

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
  const messages: Array<{ role: string; content?: string; tool_calls?: ToolCall[]; name?: string; }> = [
    {
      role: 'system',
      content:
        'You are a triage assistant. Always call both tool functions before producing a final answer. Use the tool findings to write a concise reasoning summary.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        id: event.id,
        title: event.title,
        project: event.project,
        level: event.level,
        culprit: event.culprit,
        errorMessage: event.exception?.values?.[0]?.value ?? event.title,
        stackFrames: event.exception?.values?.[0]?.stacktrace?.frames ?? [],
      }),
    },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages,
      max_tokens: 1024,
      tools: [
        {
          type: 'function',
          function: {
            name: 'rankSeverity',
            description: 'Assign a business priority for the alert.',
            parameters: {
              type: 'object',
              properties: {
                level: { type: 'string' },
                project: { type: 'string' },
                culprit: { type: 'string' },
              },
              required: ['level', 'project', 'culprit'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'investigateCodebase',
            description: 'Return likely affected files and ownership context.',
            parameters: {
              type: 'object',
              properties: {
                culprit: { type: 'string' },
                errorMessage: { type: 'string' },
                stackFrames: { type: 'array' },
              },
              required: ['culprit', 'errorMessage', 'stackFrames'],
            },
          },
        },
      ],
    });

    const toolCalls = extractToolCalls(response);
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        const name = toolCall.name;
        const args = toolCall.arguments ?? {};

        if (name === 'rankSeverity') {
          const severity = rankSeverity({
            level: String((args as Record<string, unknown>).level ?? event.level),
            project: String((args as Record<string, unknown>).project ?? event.project),
            culprit: String((args as Record<string, unknown>).culprit ?? event.culprit),
          });

          messages.push({
            role: 'tool',
            name,
            content: JSON.stringify(severity),
          });
          continue;
        }

        if (name === 'investigateCodebase') {
          const investigation = investigateCodebase({
            culprit: String((args as Record<string, unknown>).culprit ?? event.culprit),
            errorMessage: String((args as Record<string, unknown>).errorMessage ?? event.exception?.values?.[0]?.value ?? event.title),
            stackFrames: Array.isArray((args as Record<string, unknown>).stackFrames)
              ? ((args as Record<string, unknown>).stackFrames as Array<Record<string, unknown>>).map((frame) => ({
                  filename: typeof frame.filename === 'string' ? frame.filename : undefined,
                  function: typeof frame.function === 'string' ? frame.function : undefined,
                  lineno: typeof frame.lineno === 'number' ? frame.lineno : undefined,
                }))
              : (event.exception?.values?.[0]?.stacktrace?.frames ?? []),
          });

          messages.push({
            role: 'tool',
            name,
            content: JSON.stringify(investigation),
          });
        }
      }

      continue;
    }

    const finalReportText = extractResponseText(response);
    if (finalReportText) {
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
      const report = formatReport(event, severity, investigation, finalReportText);
      console.log(report);
      return finalReportText;
    }
  }

  throw new Error('Triage agent exceeded the maximum number of iterations without a final response.');
}
