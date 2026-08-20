/**
 * Bearer-token authentication for the Off Grid gateway.
 *
 * CURRENT IMPLEMENTATION — shared-secret validation (TEMPORARY / DEV ONLY).
 * The mobile client sends: `Authorization: ******
 * The Worker compares it (constant-time) against the GATEWAY_SECRET binding.
 *
 * WARNING: a mobile-shipped shared secret is NOT production-grade authentication.
 * Replace this with JWT / pro-entitlement verification before production launch.
 *
 * UPGRADE SEAM
 * When you are ready to switch, replace the body of `verifyToken` below.
 * The Worker entrypoint (index.ts) only ever calls `verifyToken(token, env)`.
 */

/** Cloudflare Worker env bindings that auth.ts depends on. */
export interface AuthEnv {
  /**
   * Shared secret used for TEMPORARY DEVELOPMENT / STAGING authentication only.
   * This is NOT production-grade Pro authentication — a mobile-shipped secret
   * provides no real security guarantees.
   * Set with: wrangler secret put GATEWAY_SECRET
   */
  GATEWAY_SECRET: string;
}

/**
 * Validate the bearer token extracted from the Authorization header.
 *
 * Returns true when the token is acceptable, false otherwise.
 * Uses crypto.subtle.timingSafeEqual (Cloudflare Workers extension) for a
 * constant-time comparison to prevent timing-oracle attacks on the secret.
 */
export function verifyToken(token: string, env: AuthEnv): boolean {
  const expected = env.GATEWAY_SECRET;
  if (!expected) {
    // Worker is misconfigured — reject all requests.
    return false;
  }

  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(expected);

  // timingSafeEqual requires equal-length buffers; unequal length leaks information
  // but is unavoidable with a fixed secret and is acceptable for this dev auth scheme.
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
