import crypto from 'crypto'
import { keys } from '../config'
import { isRevoked } from './store'

// ── Offline hub-token verification ────────────────────────────────────────────
// Apps verify the shared hub-token locally with SHARED_JWT_SECRET (no network call
// to the hub) and additionally check the offline revocation denylist. This keeps
// SSO available even when the hub is down, while still supporting revocation.
//
// Implemented with Node's built-in crypto so the package has no jsonwebtoken
// dependency and works inside Next standalone images that don't bundle it.
//
// Dual-accept during the asymmetric migration (audit H2): a token may be signed
// EITHER with RS256 (the hub's RSA private key — apps verify with the published
// public key and CANNOT mint) OR with HS256 (the legacy shared secret, still used
// by older sessions until they expire). The header `alg` selects the path; RS256
// additionally matches the header `kid` against the published public keys (or tries
// all of them when no kid is present) to support zero-downtime key rotation.

export interface HubJwtPayload {
  userId: string
  email: string
  fullName?: string
  iss: string
  jti?: string
  iat?: number
  exp?: number
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
  const all = keys.hubPublicKeys()
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
 * Verify a hub-token: an RS256 (asymmetric) OR HS256 (legacy shared-secret)
 * signature, plus `iss==='hub'`, not expired, and jti not revoked. Returns the
 * payload or null.
 */
export function verifyHubToken(token: string | undefined | null): HubJwtPayload | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts

  const header = b64urlJson(headerB64)
  if (!header) return null
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = b64urlDecode(sigB64)

  // RS256-only (Stage 4): HS256 is retired — the hub is the sole minter via its
  // private key; apps verify with the published public key(s) and cannot forge.
  if (header.alg !== 'RS256') return null
  if (!verifyRs256(signingInput, sig, header.kid as string | undefined)) return null

  const payload = b64urlJson(payloadB64) as HubJwtPayload | null
  if (!payload || payload.iss !== 'hub') return null
  if (payload.exp && Date.now() / 1000 > payload.exp) return null
  if (isRevoked(payload.jti)) return null
  return payload
}
