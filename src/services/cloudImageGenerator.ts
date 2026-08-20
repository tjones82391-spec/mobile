/**
 * Cloud image generator — sends generation requests to the Off Grid gateway
 * Worker, which proxies them to Fal.ai without exposing the Fal API key on
 * the device.
 *
 * Contract (mirrors the local onnxImageGeneratorService used by ImageGenerationService):
 *   - generateImage(params, onProgress?, onPreview?, signal?) → GeneratedImage
 *   - cancel()
 *
 * Authentication: reads a bearer token from Keychain.  The token is the shared
 * gateway secret (temporary); replace with a pro-entitlement JWT later by
 * updating storeGatewayToken / getGatewayToken only — no other changes needed.
 *
 * The FAL_API_KEY is NEVER present in this file or anywhere in the mobile app.
 */

import * as Keychain from 'react-native-keychain';
import RNFS from 'react-native-fs';
import { fetchWithTimeout } from './httpClient';
import { generateId } from '../utils/generateId';
import logger from '../utils/logger';
import type { GeneratedImage } from '../types';
import type { GatewayImageRequest, GatewayImageResponse } from './cloudImageGeneratorTypes';

// ---------------------------------------------------------------------------
// Sentinel error — thrown (and only thrown) when generation is cancelled.
// Callers use `instanceof CloudGenerationCancelledError` instead of fragile
// string matching.
// ---------------------------------------------------------------------------

export class CloudGenerationCancelledError extends Error {
  constructor() {
    super('Cloud image generation was cancelled');
    this.name = 'CloudGenerationCancelledError';
  }
}

// ---------------------------------------------------------------------------
// Keychain helpers — gateway token storage
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'ai.offgridmobile.gateway';
const KEYCHAIN_USERNAME = 'gateway_token';

/** Persist the gateway bearer token in the device keychain. */
export async function storeGatewayToken(token: string): Promise<void> {
  await Keychain.setGenericPassword(KEYCHAIN_USERNAME, token, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
  });
}

/** Retrieve the gateway bearer token from the device keychain, or null if absent. */
export async function getGatewayToken(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch (err) {
    logger.error('[CloudImageGenerator] Failed to read gateway token:', err);
    return null;
  }
}

/** Remove the gateway bearer token (e.g., on logout). */
export async function removeGatewayToken(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Base URL of the deployed gateway Worker.
 * Override via the pro module's runtime config; this constant is the fallback.
 *
 * No trailing slash.
 */
let _gatewayUrl = 'https://offgrid-gateway.offgrid-ai.workers.dev';

/** Inject the gateway URL at runtime (called by the pro module on app start). */
export function setGatewayUrl(url: string): void {
  _gatewayUrl = url.replace(/\/$/, '');
}

export function getGatewayUrl(): string {
  return _gatewayUrl;
}

// ---------------------------------------------------------------------------
// Params / result types
// ---------------------------------------------------------------------------

export interface CloudGenerateParams {
  prompt: string;
  negativePrompt?: string;
  steps: number;
  guidanceScale: number;
  width: number;
  height: number;
  seed?: number;
  modelId: string;
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

class CloudImageGeneratorService {
  private _abortController: AbortController | null = null;
  private _cancelled = false;

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Returns true when the cloud generator is available — i.e. the gateway
   * URL is configured and a bearer token is present in Keychain.
   *
   * Does NOT perform a network check; call this synchronously before deciding
   * whether to route to the cloud path.
   */
  async isAvailable(): Promise<boolean> {
    const token = await getGatewayToken();
    return !!token;
  }

  /**
   * Generate an image via the gateway.
   *
   * @param params       Generation parameters.
   * @param onProgress   Optional progress callback — called with synthetic progress
   *                     updates while waiting for the gateway (cloud has no step-level
   *                     progress, so we emit deterministic pings).
   * @param signal       Optional AbortSignal; cancels the request mid-flight.
   * @returns            A GeneratedImage with a local file path.
   * @throws             On auth failure, gateway error, network error, or cancellation.
   */
  async generateImage(
    params: CloudGenerateParams,
    onProgress?: (progress: { step: number; totalSteps: number }) => void,
    signal?: AbortSignal,
  ): Promise<GeneratedImage> {
    this._cancelled = false;
    this._abortController = new AbortController();

    // Forward the external signal into our internal controller.
    if (signal) {
      signal.addEventListener('abort', () => this._abortController?.abort());
    }

    const token = await getGatewayToken();
    if (!token) {
      throw new Error('Cloud image generation requires a gateway token. Please verify your Pro subscription.');
    }

    const requestBody: GatewayImageRequest = {
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      steps: params.steps,
      guidanceScale: params.guidanceScale,
      width: params.width,
      height: params.height,
      seed: params.seed,
      modelId: params.modelId,
    };

    logger.log('[CloudImageGenerator] Submitting to gateway:', _gatewayUrl, '| model:', params.modelId);

    // Emit a synthetic "step 0" so the UI shows progress immediately.
    onProgress?.({ step: 0, totalSteps: params.steps });

    // The gateway polls Fal internally; the mobile request is a single long-lived HTTP
    // call.  We set a generous timeout (120s) to accommodate cold starts + diffusion.
    const GENERATION_TIMEOUT_MS = 120_000;

    let responseData: GatewayImageResponse;
    try {
      responseData = await fetchWithTimeout<GatewayImageResponse>(
        `${_gatewayUrl}/image/generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
          },
          body: JSON.stringify(requestBody),
          timeout: GENERATION_TIMEOUT_MS,
          signal: this._abortController.signal,
        },
      );
    } catch (err: any) {
      if (this._cancelled || err?.name === 'AbortError') {
        throw new CloudGenerationCancelledError();
      }
      // fetchWithTimeout already throws on non-2xx with the response body.
      logger.error('[CloudImageGenerator] Gateway request failed:', err);
      throw err;
    }

    if (this._cancelled) {
      throw new CloudGenerationCancelledError();
    }

    // Emit a synthetic "steps complete" progress update.
    onProgress?.({ step: params.steps, totalSteps: params.steps });

    // Download the generated image from the CDN URL to local app storage.
    const localPath = await this._downloadImage(responseData.imageUrl, params.modelId);

    const fileName = localPath.split('/').pop() ?? 'generated.png';

    return {
      id: generateId(),
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      imagePath: localPath,
      fileName,
      width: responseData.width,
      height: responseData.height,
      steps: responseData.steps,
      seed: responseData.seed,
      modelId: responseData.modelId,
      createdAt: new Date().toISOString(),
      conversationId: params.conversationId,
    };
  }

  /**
   * Cancel an in-flight generation.  Safe to call when idle.
   */
  cancel(): void {
    this._cancelled = true;
    this._abortController?.abort();
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Download the image at `url` to the app's Documents directory and return
   * the absolute local path (without `file://` prefix, matching the convention
   * used by localDreamGenerator).
   */
  private async _downloadImage(url: string, modelId: string): Promise<string> {
    const timestamp = Date.now();
    const safeModelId = modelId.replace(/[^a-z0-9]/gi, '_');
    const fileName = `fal_${safeModelId}_${timestamp}.png`;
    // Use the same base directory as locally-generated images to keep the rest
    // of the app's file-management code working without modification.
    const destPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;

    logger.log('[CloudImageGenerator] Downloading image to:', destPath);

    try {
      const downloadResult = await RNFS.downloadFile({
        fromUrl: url,
        toFile: destPath,
      }).promise;
      if (downloadResult.statusCode < 200 || downloadResult.statusCode >= 300) {
        throw new Error(`Image download returned HTTP ${downloadResult.statusCode}`);
      }
    } catch (err) {
      logger.error('[CloudImageGenerator] Image download failed:', err);
      throw new Error(`Failed to download generated image: ${err instanceof Error ? err.message : String(err)}`);
    }

    return destPath;
  }
}

export const cloudImageGenerator = new CloudImageGeneratorService();
