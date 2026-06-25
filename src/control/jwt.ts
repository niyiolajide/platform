import crypto from 'crypto'
import { keys } from '../config'
import { isRevoked } from './store'

// ── Offline pulse-token verification ────────────────────────────────────────────
// Apps verify the shared pulse-token locally against ControlPlane's published RS256
// public key(s) (no network call) and additionally check the offline revocation
// denylist. This keeps SSO available even when ControlPlane is down, while still
// supporting revocation. Implemented with Node's built-in crypto so the package has
// no jsonwebtoken dependency and works inside Next standalone images.
//
// RS256-ONLY (Stage 4): ControlPlane is the sole minter via its RSA private key; apps
// verify with the published public key(s) and CANNOT forge. The header `kid` is matched
// against the published keys (or every key is tried when no kid is present) to support
// zero-downtime key rotation. HS256/shared-secret signing is fully retired.
//
// Claims enforced: `iss==='controlplane'`, RS256 signature, a REQUIRED `exp` (a token
// with no expiry is rejected — there must be no immortal tokens), `nbf` when present,
// an optional caller-supplied `expectedAud` (service/job tokens carry an `aud`), and
// the offline `jti` revocation denylist. A small clock-skew tolerance is allowed.

const CLOCK_SKEW_S = 30

export interface PulseJwtPayload {
  userId: string
  email: string
  fullName?: string
  iss: string
  jti?: string
  aud?: string | string[]
  iat?: number
  nbf?: number
  exp?: number
}

export interface VerifyPulseTokenOptions {
  /**
   * When set, the token's `aud` must equal (or, for an array `aud`, include) this value.
   * Lets a service/job token scoped for app A be rejected at app B. Omit to skip the check.
   */
  expectedAud?: string
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(b64urlDecode(s).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Verify an RS256 signature against the published hub public key(s). When a `kid`
 * is present only the matching key is tried; otherwise every published key is tried
 * (so rotation never locks anyone out). Returns true if any candidate verifies.
 */
function verifyRs256(signingInput: string, sig: Buffer, kid: string | undefined): boolean {
  const all = keys.pulsePublicKeys()
  const candidates = kid ? all.filter((k) => k.kid === kid) : all
  // If a kid was supplied but doesn't match any known key, fall back to trying all
  // (tolerates a token minted under a key not yet in this app's env).
  const toTry = candidates.length > 0 ? candidates : all
  const data = Buffer.from(signingInput)
  for (const k of toTry) {
    try {
      if (crypto.verify('RSA-SHA256', data, k.pem, sig)) return true
    } catch {
      // malformed key PEM — skip
    }
  }
  return false
}

/**
 * Verify a pulse-token: an RS256 signature against ControlPlane's published key(s),
 * `iss==='controlplane'`, a REQUIRED non-expired `exp`, `nbf` (when present), an
 * optional `expectedAud`, and `jti` not revoked. Returns the payload or null.
 */
export function verifyPulseToken(
  token: string | undefined | null,
  opts: VerifyPulseTokenOptions = {},
): PulseJwtPayload | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts

  const header = b64urlJson(headerB64)
  if (!header) return null
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = b64urlDecode(sigB64)

  // RS256-only (Stage 4): HS256 is retired — ControlPlane is the sole minter via its
  // private key; apps verify with the published public key(s) and cannot forge.
  if (header.alg !== 'RS256') return null
  if (!verifyRs256(signingInput, sig, header.kid as string | undefined)) return null

  const payload = b64urlJson(payloadB64) as PulseJwtPayload | null
  if (!payload || payload.iss !== 'controlplane') return null

  const now = Date.now() / 1000
  // Require an expiry — a token with no `exp` would be valid forever and is unprunable
  // from the revocation denylist; reject it outright. (Every ControlPlane minter sets exp.)
  // Strict (no skew): never extend a token's life past its stated expiry.
  if (typeof payload.exp !== 'number' || now > payload.exp) return null
  // Enforce not-before when present (small skew tolerance for a just-minted token whose
  // nbf is marginally ahead of this host's clock).
  if (typeof payload.nbf === 'number' && now < payload.nbf - CLOCK_SKEW_S) return null
  // Optional audience scoping — reject a token minted for a different service.
  if (opts.expectedAud) {
    const aud = payload.aud
    const ok = Array.isArray(aud) ? aud.includes(opts.expectedAud) : aud === opts.expectedAud
    if (!ok) return null
  }
  if (isRevoked(payload.jti)) return null
  return payload
}
