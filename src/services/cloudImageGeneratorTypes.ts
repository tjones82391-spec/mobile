/**
 * Mobile-side types for the Off Grid cloud image-generation gateway.
 *
 * These mirror the types in gateway/src/types.ts so the mobile build has no
 * compile-time dependency on the Worker source.  Keep both files in sync when
 * adding or removing fields.
 */

/** Payload sent to POST <gatewayUrl>/image/generate. */
export interface GatewayImageRequest {
  prompt: string;
  negativePrompt?: string;
  steps: number;
  guidanceScale: number;
  width: number;
  height: number;
  seed?: number;
  modelId: string;
}

/** Successful response from the gateway. */
export interface GatewayImageResponse {
  imageUrl: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  modelId: string;
}

/** Error body returned by the gateway on 4xx / 5xx. */
export interface GatewayErrorResponse {
  error: string;
}
