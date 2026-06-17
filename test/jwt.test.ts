import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { verifyHubToken } from '../src/control/jwt'
import { revokeJti, _clearCache } from '../src/control'

const SECRET = 'test-shared-secret-at-least-32-characters-long'

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mintHubToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest())
  return `${header}.${body}.${sig}`
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-'))
  process.env.CONTROL_DIR = dir
  process.env.SHARED_JWT_SECRET = SECRET
  _clearCache()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('verifyHubToken', () => {
  const base = { userId: 'u1', email: 'a@b.com', iss: 'hub', exp: Math.floor(Date.now() / 1000) + 3600 }

  it('accepts a valid hub token', () => {
    const t = mintHubToken({ ...base, jti: 'j1' })
    expect(verifyHubToken(t)?.userId).toBe('u1')
  })

  it('rejects a wrong signature', () => {
    const t = mintHubToken({ ...base }).slice(0, -2) + 'xx'
    expect(verifyHubToken(t)).toBeNull()
  })

  it('rejects a non-hub issuer', () => {
    expect(verifyHubToken(mintHubToken({ ...base, iss: 'other' }))).toBeNull()
  })

  it('rejects an expired token', () => {
    expect(verifyHubToken(mintHubToken({ ...base, exp: Math.floor(Date.now() / 1000) - 5 }))).toBeNull()
  })

  it('rejects a revoked jti (offline revocation)', () => {
    const t = mintHubToken({ ...base, jti: 'revoked-1' })
    expect(verifyHubToken(t)?.userId).toBe('u1')
    revokeJti('revoked-1', base.exp)
    _clearCache()
    expect(verifyHubToken(t)).toBeNull()
  })
})
