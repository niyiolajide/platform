import crypto from 'crypto'
import { keys } from '../config'
import { isRevoked } from './store'

// ── Offline hub-token verification ────────────────────────────────────────────
// Apps verify the shared hub-token locally with SHARED_JWT_SECRET (no network call
// to the hub) and additionally check the offline revocation denylist. This keeps
// SSO available even when the hub is down, while still supporting revocation.
//
// Implemented with Node's built-in crypto (HS256) so the package has no jsonwebtoken
// dependency and works inside Next standalone images that don't bundle it.

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
 * Verify a hub-token: HS256 signature against SHARED_JWT_SECRET, `iss==='hub'`,
 * not expired, and jti not revoked. Returns the payload or null.
 */
export function verifyHubToken(token: string | undefined | null): HubJwtPayload | null {
  if (!token) return null
  const secret = keys.sharedJwtSecret()
  if (!secret) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts

  const header = b64urlJson(headerB64)
  if (!header || header.alg !== 'HS256') return null

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  const given = b64urlDecode(sigB64)
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null

  const payload = b64urlJson(payloadB64) as HubJwtPayload | null
  if (!payload || payload.iss !== 'hub') return null
  if (payload.exp && Date.now() / 1000 > payload.exp) return null
  if (isRevoked(payload.jti)) return null
  return payload
}
