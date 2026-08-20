/**
 * Fal.ai client for the Off Grid gateway Worker.
 *
 * Responsibilities:
 *  - Allowlist permitted Fal model IDs (never blindly forward client-supplied IDs).
 *  - Call the Fal queue REST API with the server-side FAL_API_KEY.
 *  - Poll for the result and return a normalised GatewayImageResponse.
 *
 * The FAL_API_KEY never leaves this Worker — it is injected via Cloudflare secrets
 * and is never present in the mobile app.
 */

import type { GatewayImageRequest, GatewayImageResponse } from './types';

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Permitted Fal model identifiers.
 * The Worker validates the client-supplied modelId against this set.
 * Add new models here when they are approved for production use.
 */
export const ALLOWED_FAL_MODELS = new Set([
  'fal-ai/flux/schnell',
  'fal-ai/flux/dev',
  'fal-ai/flux-realism',
  'fal-ai/stable-diffusion-v3-medium',
]);

// ---------------------------------------------------------------------------
// Env binding
// ---------------------------------------------------------------------------

export interface FalEnv {
  /** Fal.ai API key.  Set with: wrangler secret put FAL_API_KEY */
  FAL_API_KEY: string;
}

// ---------------------------------------------------------------------------
// Types mirroring Fal queue API responses
// ---------------------------------------------------------------------------

interface FalQueueSubmitResponse {
  request_id: string;
  status: string;
}

interface FalQueueStatusResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  request_id: string;
  response_url?: string;
}

interface FalImageResult {
  images: Array<{
    url: string;
    width?: number;
    height?: number;
    content_type?: string;
  }>;
  seed?: number;
  timings?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAL_QUEUE_BASE = 'https://queue.fal.run';
/** Maximum number of status-poll attempts before giving up. */
const MAX_POLL_ATTEMPTS = 55;
/** Milliseconds between poll attempts. */
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Validate that the model ID is on the allowlist.
 * Returns the model ID unchanged, or throws if it is not permitted.
 */
export function validateModelId(modelId: string): string {
  if (!ALLOWED_FAL_MODELS.has(modelId)) {
    throw new FalClientError(`Model '${modelId}' is not permitted`, 400);
  }
  return modelId;
}

/** Domain error for Fal client failures. Carries an HTTP status hint. */
export class FalClientError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 502,
  ) {
    super(message);
    this.name = 'FalClientError';
  }
}

/**
 * Submit a generation job to Fal and wait for the result.
 *
 * Throws `FalClientError` on validation failure, Fal API errors, or timeout.
 */
export async function generate(
  req: GatewayImageRequest,
  env: FalEnv,
): Promise<GatewayImageResponse> {
  const modelId = validateModelId(req.modelId);

  const authHeader = `Key ${env.FAL_API_KEY}`;

  // 1. Submit the job to the Fal queue.
  const submitUrl = `${FAL_QUEUE_BASE}/${modelId}`;
  const submitBody = {
    prompt: req.prompt,
    negative_prompt: req.negativePrompt ?? '',
    num_inference_steps: req.steps,
    guidance_scale: req.guidanceScale,
    image_size: { width: req.width, height: req.height },
    seed: req.seed,
    sync_mode: false,
    num_images: 1,
  };

  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => '');
    throw new FalClientError(
      `Fal submit failed (${submitRes.status}): ${body}`,
      502,
    );
  }

  const submitted: FalQueueSubmitResponse = await submitRes.json();
  const { request_id } = submitted;

  // 2. Poll the status endpoint until COMPLETED or FAILED.
  const statusUrl = `${FAL_QUEUE_BASE}/${modelId}/requests/${request_id}/status`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: authHeader },
    });

    if (!statusRes.ok) {
      const body = await statusRes.text().catch(() => '');
      throw new FalClientError(
        `Fal status check failed (${statusRes.status}): ${body}`,
        502,
      );
    }

    const status: FalQueueStatusResponse = await statusRes.json();

    if (status.status === 'FAILED') {
      throw new FalClientError('Fal generation job failed', 502);
    }

    if (status.status === 'COMPLETED') {
      // 3. Fetch the result payload.
      const resultUrl =
        status.response_url ??
        `${FAL_QUEUE_BASE}/${modelId}/requests/${request_id}`;

      const resultRes = await fetch(resultUrl, {
        headers: { Authorization: authHeader },
      });

      if (!resultRes.ok) {
        const body = await resultRes.text().catch(() => '');
        throw new FalClientError(
          `Fal result fetch failed (${resultRes.status}): ${body}`,
          502,
        );
      }

      const result: FalImageResult = await resultRes.json();
      const image = result.images?.[0];

      if (!image?.url) {
        throw new FalClientError('Fal result contained no image URL', 502);
      }

      return {
        imageUrl: image.url,
        width: image.width ?? req.width,
        height: image.height ?? req.height,
        seed: result.seed ?? req.seed ?? 0,
        steps: req.steps,
        modelId,
      };
    }
    // IN_QUEUE or IN_PROGRESS — keep polling.
  }

  throw new FalClientError(
    `Fal generation timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`,
    504,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
