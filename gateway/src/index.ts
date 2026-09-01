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

  // 2b. Field-level validation — reject out-of-range values before calling Fal.
  if (body.prompt.length < 1 || body.prompt.length > 2000) {
    return c.json<GatewayErrorResponse>(
      { error: 'prompt must be between 1 and 2000 characters' },
      400,
    );
  }

  if (body.negativePrompt != null) {
    if (typeof body.negativePrompt !== 'string' || body.negativePrompt.length > 2000) {
      return c.json<GatewayErrorResponse>(
        { error: 'negativePrompt must be a string of at most 2000 characters' },
        400,
      );
    }
  }

  const steps = Number(body.steps);
  if (!Number.isFinite(steps) || !Number.isInteger(steps) || steps < 1 || steps > 100) {
    return c.json<GatewayErrorResponse>(
      { error: 'steps must be an integer between 1 and 100' },
      400,
    );
  }

  const guidanceScale = Number(body.guidanceScale);
  if (!Number.isFinite(guidanceScale) || guidanceScale < 1 || guidanceScale > 20) {
    return c.json<GatewayErrorResponse>(
      { error: 'guidanceScale must be a number between 1 and 20' },
      400,
    );
  }

  const width = Number(body.width);
  if (
    !Number.isFinite(width) ||
    !Number.isInteger(width) ||
    width < 64 ||
    width > 2048 ||
    width % 8 !== 0
  ) {
    return c.json<GatewayErrorResponse>(
      { error: 'width must be an integer between 64 and 2048 and a multiple of 8' },
      400,
    );
  }

  const height = Number(body.height);
  if (
    !Number.isFinite(height) ||
    !Number.isInteger(height) ||
    height < 64 ||
    height > 2048 ||
    height % 8 !== 0
  ) {
    return c.json<GatewayErrorResponse>(
      { error: 'height must be an integer between 64 and 2048 and a multiple of 8' },
      400,
    );
  }

  if (body.seed != null) {
    const seed = Number(body.seed);
    if (!Number.isFinite(seed) || !Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
      return c.json<GatewayErrorResponse>(
        { error: 'seed must be an integer between 0 and 2147483647' },
        400,
      );
    }
  }

  // 3. Build the validated request object.
  const req: GatewayImageRequest = {
    prompt: body.prompt,
    negativePrompt: body.negativePrompt,
    steps,
    guidanceScale,
    width,
    height,
    seed: body.seed != null ? Number(body.seed) : undefined,
    modelId: body.modelId,
  };

  // 4. Call Fal (model allowlist validated inside generate()).
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
