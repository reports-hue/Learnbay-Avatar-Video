import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Tiny HMAC-signed session token for the single-user login feature.
 *
 * Format:   `<base64urlPayload>.<base64urlSignature>`
 * Payload:  `{ email: string, exp: number }` (exp = unix ms)
 * Signature: HMAC-SHA256(payload, LOGIN_PASSWORD)
 *
 * Why use LOGIN_PASSWORD as the signing key (not a separate AUTH_SECRET):
 *   - One fewer secret for the user to manage.
 *   - When the user rotates LOGIN_PASSWORD, ALL existing tokens auto-invalidate
 *     because the signature no longer verifies — clean session rotation for free.
 *   - The signing key is never sent over the wire; only the token is.
 *
 * This is intentionally a tiny in-house implementation (no jsonwebtoken dep)
 * because the auth requirement is a single hardcoded user — not a multi-tenant
 * system. Constant-time comparison via crypto.timingSafeEqual prevents
 * signature timing attacks.
 */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface TokenPayload {
  email: string;
  exp: number;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function getSigningKey(): string {
  const key = process.env.LOGIN_PASSWORD;
  if (!key) {
    throw new Error("LOGIN_PASSWORD env var is not set — cannot issue/verify auth tokens");
  }
  return key;
}

export function issueToken(email: string): string {
  const payload: TokenPayload = { email, exp: Date.now() + TOKEN_TTL_MS };
  const payloadEncoded = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", getSigningKey()).update(payloadEncoded).digest();
  return `${payloadEncoded}.${b64urlEncode(sig)}`;
}

export interface VerifyResult {
  ok: boolean;
  email?: string;
  reason?: "malformed" | "bad_signature" | "expired";
}

export function verifyToken(token: string | undefined | null): VerifyResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadEncoded, sigProvided] = parts as [string, string];
  if (!payloadEncoded || !sigProvided) return { ok: false, reason: "malformed" };

  // Recompute signature with current LOGIN_PASSWORD. If the user rotated the
  // password, this will mismatch and force re-login (intended behavior).
  let sigExpected: Buffer;
  try {
    sigExpected = createHmac("sha256", getSigningKey()).update(payloadEncoded).digest();
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const sigGiven = b64urlDecode(sigProvided);
  if (sigGiven.length !== sigExpected.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(sigGiven, sigExpected)) return { ok: false, reason: "bad_signature" };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadEncoded).toString("utf8")) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.email !== "string" || typeof payload.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (Date.now() > payload.exp) return { ok: false, reason: "expired" };

  return { ok: true, email: payload.email };
}

/**
 * Constant-time string comparison for credential checks. Wraps timingSafeEqual
 * with length-equalization (timingSafeEqual throws when buffers differ in length,
 * which itself leaks length information).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison to make timing roughly equal regardless of length.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
