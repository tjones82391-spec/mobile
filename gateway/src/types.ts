/**
 * Shared gateway request/response types.
 *
 * Kept in a dedicated file so both the Worker entrypoint (index.ts) and
 * the individual handlers (falClient.ts) can import them without circular deps.
 * The mobile-side mirror is src/services/cloudImageGeneratorTypes.ts.
 */

/** Payload the mobile client sends to POST /image/generate. */
export interface GatewayImageRequest {
  /** User-visible prompt text. */
  prompt: string;
  /** Negative prompt (optional). */
  negativePrompt?: string;
  /** Number of diffusion steps. */
  steps: number;
  /** Guidance scale. */
  guidanceScale: number;
  /** Output image width in pixels. */
  width: number;
  /** Output image height in pixels. */
  height: number;
  /** RNG seed for reproducibility (optional). */
  seed?: number;
  /**
   * Fal model identifier as listed in ALLOWED_FAL_MODELS.
   * The Worker validates this against the allowlist before forwarding.
   */
  modelId: string;
}

/** Successful response the Worker returns to the mobile client. */
export interface GatewayImageResponse {
  /** Public URL of the generated image (may be a Fal CDN URL). */
  imageUrl: string;
  /** Actual output width. */
  width: number;
  /** Actual output height. */
  height: number;
  /** Seed used for generation. */
  seed: number;
  /** Steps used for generation. */
  steps: number;
  /** Echo of the requested model ID. */
  modelId: string;
}

/** Error response body returned for 4xx/5xx. */
export interface GatewayErrorResponse {
  error: string;
}
