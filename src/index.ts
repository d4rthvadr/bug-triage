import { runTriageAgent, type AiLike } from './agent';
import type { AlertEventPayload } from './types';

export interface Env {
  AI: AiLike;
  SENTRY_WEBHOOK_SECRET?: string;
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

    ctx.waitUntil(runTriageAgent(payload, env.AI));
    return new Response('OK', { status: 200 });
  },
};
