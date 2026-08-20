/**
 * Bearer-token authentication for the Off Grid gateway.
 *
 * CURRENT IMPLEMENTATION — shared-secret validation.
 * The mobile client sends: `Authorization: ******
 * The Worker compares it (constant-time) against the GATEWAY_SECRET binding.
 *
 * UPGRADE SEAM
 * When you are ready to switch to JWT / pro-entitlement verification, replace the
 * body of `verifyToken` below.  The Worker entrypoint (index.ts) only ever calls
 * `verifyToken(token, env)` — it has no knowledge of the mechanism.
 */

/** Cloudflare Worker env bindings that auth.ts depends on. */
export interface AuthEnv {
  /** Shared secret.  Set with: wrangler secret put GATEWAY_SECRET */
  GATEWAY_SECRET: string;
}

/**
 * Validate the bearer token extracted from the Authorization header.
 *
 * Returns true when the token is acceptable, false otherwise.
 * Uses a timing-safe comparison to prevent timing-oracle attacks on the secret.
 */
export async function verifyToken(token: string, env: AuthEnv): Promise<boolean> {
  const expected = env.GATEWAY_SECRET;
  if (!expected) {
    // Worker is misconfigured — reject all requests.
    return false;
  }

  // Constant-time byte comparison via SubtleCrypto to avoid timing-oracle on the secret.
  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(expected);

  if (a.byteLength !== b.byteLength) {
    // Length difference leaks information, but it is unavoidable with a fixed secret.
    // The SubtleCrypto HMAC approach below is the correct long-term solution; for the
    // shared-secret phase this is acceptable because the secret is long and random.
    return false;
  }

  // Use HMAC-SHA256 sign+verify as a constant-time equals: sign both values with a
  // random ephemeral key and compare the MACs (equal iff inputs are equal).
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const macA = await crypto.subtle.sign('HMAC', key, a);
  const macB = await crypto.subtle.sign('HMAC', key, b);

  const va = new Uint8Array(macA);
  const vb = new Uint8Array(macB);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i] ^ vb[i];
  }
  return diff === 0;
}
