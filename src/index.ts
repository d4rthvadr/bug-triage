import { parseRepositoryMapping } from './config';
import { createD1TriageStore } from './store';
import { processTriggeredEvent, type AiLike } from './agent';
import type { AlertEventPayload } from './types';

export interface Env {
  AI: AiLike;
  SENTRY_WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  GITHUB_API_BASE_URL?: string;
  PROJECT_REPOSITORY_MAP?: string;
  SLACK_WEBHOOK_URL?: string;
  PAGERDUTY_WEBHOOK_URL?: string;
  TRIAGE_RESULTS?: D1Database;
}

async function verifySignature(secret: string | undefined, rawBody: string, signature: string | null): Promise<boolean> {
  if (!secret) return true;
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return expected === signature.toLowerCase();
}

function buildRepositoryMapping(env: Env): Record<string, { owner: string; repo: string; branch?: string }> {
  return parseRepositoryMapping(env.PROJECT_REPOSITORY_MAP);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/webhook/sentry') {
      return new Response('Not found', { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('sentry-hook-signature');
    const valid = await verifySignature(env.SENTRY_WEBHOOK_SECRET, rawBody, signature);

    if (!valid) {
      return new Response('Unauthorized', { status: 401 });
    }

    let payload: AlertEventPayload;
    try {
      payload = JSON.parse(rawBody) as AlertEventPayload;
    } catch (_error) {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (payload.action !== 'triggered') {
      return new Response('Ignored', { status: 200 });
    }

    const dependencies = {
      investigation: {
        github: {
          baseUrl: env.GITHUB_API_BASE_URL,
          token: env.GITHUB_TOKEN,
        },
        repositoryMapping: buildRepositoryMapping(env),
      },
      notification: {
        slackWebhookUrl: env.SLACK_WEBHOOK_URL,
        pagerDutyWebhookUrl: env.PAGERDUTY_WEBHOOK_URL,
      },
      store: env.TRIAGE_RESULTS ? createD1TriageStore(env.TRIAGE_RESULTS) : undefined,
      rawPayload: rawBody,
    };

    ctx.waitUntil(processTriggeredEvent(payload, env.AI, dependencies));
    return new Response('OK', { status: 200 });
  },
};
