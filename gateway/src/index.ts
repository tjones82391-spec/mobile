/**
 * Off Grid Gateway — Cloudflare Worker entrypoint.
 *
 * Routes:
 *   POST /image/generate — proxy image-generation to Fal.ai
 *
 * Authentication:  Bearer-token (shared secret, replaceable — see src/auth.ts).
 * Key handling:    FAL_API_KEY lives exclusively in the Worker secret store.
 *                  It is never sent to or stored on the mobile client.
 */

import { Hono } from 'hono';
import { verifyToken, type AuthEnv } from './auth';
import { generate, FalClientError, type FalEnv } from './falClient';
import type { GatewayImageRequest, GatewayImageResponse, GatewayErrorResponse } from './types';

// ---------------------------------------------------------------------------
// Worker env bindings (union of all binding interfaces)
// ---------------------------------------------------------------------------

type Env = AuthEnv & FalEnv;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/', c => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// POST /image/generate
// ---------------------------------------------------------------------------

app.post('/image/generate', async c => {
  // 1. Authenticate.
  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  if (!token) {
    return c.json<GatewayErrorResponse>({ error: 'Missing Authorization header' }, 401);
  }

  const valid = await verifyToken(token, c.env);
  if (!valid) {
    return c.json<GatewayErrorResponse>({ error: 'Unauthorized' }, 401);
  }

  // 2. Parse and validate the request body.
  let body: GatewayImageRequest;
  try {
    body = await c.req.json<GatewayImageRequest>();
  } catch {
    return c.json<GatewayErrorResponse>({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.prompt || typeof body.prompt !== 'string') {
    return c.json<GatewayErrorResponse>({ error: 'prompt is required' }, 400);
  }
  if (!body.modelId || typeof body.modelId !== 'string') {
    return c.json<GatewayErrorResponse>({ error: 'modelId is required' }, 400);
  }

  // Numeric defaults — safe so malformed clients don't explode Fal.
  const req: GatewayImageRequest = {
    prompt: body.prompt,
    negativePrompt: body.negativePrompt,
    steps: Number(body.steps) || 8,
    guidanceScale: Number(body.guidanceScale) || 7.5,
    width: Number(body.width) || 512,
    height: Number(body.height) || 512,
    seed: body.seed != null ? Number(body.seed) : undefined,
    modelId: body.modelId,
  };

  // 3. Call Fal (model allowlist validated inside generate()).
  try {
    const result: GatewayImageResponse = await generate(req, c.env);
    return c.json<GatewayImageResponse>(result, 200);
  } catch (err) {
    if (err instanceof FalClientError) {
      const status = err.httpStatus as 400 | 401 | 502 | 504;
      return c.json<GatewayErrorResponse>({ error: err.message }, status);
    }
    // Unexpected error — don't leak internal details.
    console.error('[Gateway] Unexpected error:', err);
    return c.json<GatewayErrorResponse>({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Export the Hono fetch handler as the Worker default export
// ---------------------------------------------------------------------------

export default app;
