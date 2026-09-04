import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { verifyPulseToken } from '../src/control/jwt'
import { publishRevocations, revokeJti, _clearCache } from '../src/control'
import { keys } from '../src/config'

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

// ── RS256 (asymmetric) helpers ─────────────────────────────────────────────────
const KID = 'test-kid-1'
const { publicKey: PUB_PEM, privateKey: PRIV_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
// A second, unrelated keypair to prove wrong-key rejection.
const { privateKey: WRONG_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function mintRs256(payload: Record<string, unknown>, opts: { kid?: string; key?: string } = {}): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(opts.kid !== undefined ? { kid: opts.kid } : {}) }))
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), opts.key ?? PRIV_PEM))
  return `${header}.${body}.${sig}`
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-'))
  process.env.CONTROL_DIR = dir
  process.env.PULSE_TOKEN_PUBLIC_KEYS = JSON.stringify([
    { kid: KID, pem: Buffer.from(PUB_PEM).toString('base64') },
  ])
  delete process.env.CONTROL_REVOCATIONS_GRACE_MS
  publishRevocations({ schemaVersion: 1, revoked: [] })
  _clearCache()
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.PULSE_TOKEN_PUBLIC_KEYS
  delete process.env.CONTROL_REVOCATIONS_GRACE_MS
})

describe('retired shared JWT configuration', () => {
  it('does not expose the retired symmetric signing secret accessor', () => {
    expect('sharedJwtSecret' in keys).toBe(false)
  })
})

describe('verifyPulseToken', () => {
  const base = { userId: 'u1', email: 'a@b.com', iss: 'controlplane', exp: Math.floor(Date.now() / 1000) + 3600 }

  it('accepts a valid RS256 hub token only while revocation state is available', () => {
    const t = mintRs256({ ...base, jti: 'j1' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    const revocationsFile = path.join(dir, 'revocations.json')
    fs.writeFileSync(revocationsFile, '{ invalid json')
    _clearCache()
    expect(verifyPulseToken(t)).toBeNull()

    fs.rmSync(revocationsFile)
    _clearCache()
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('recovers once the denylist returns, without a cache reset', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '0'
    const t = mintRs256({ ...base, jti: 'recover-1' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    fs.rmSync(path.join(dir, 'revocations.json'))
    expect(verifyPulseToken(t)).toBeNull()

    // No _clearCache() here on purpose: recovery must come from the reader noticing
    // the bundle again, not from a test-only cache reset.
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(verifyPulseToken(t)?.userId).toBe('u1')
  })

  it('recovers when the bundle is restored by something outside this process', () => {
    // The test above restores via the library publisher, which invalidates the read
    // cache for us. Real recovery has no such hook: an operator, a redeploy, or
    // ControlPlane's own in-place writer just puts the file back.
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '0'
    vi.useFakeTimers({ toFake: ['Date', 'performance'], now: Date.now() })
    const t = mintRs256({ ...base, jti: 'external-1' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    const file = path.join(dir, 'revocations.json')
    fs.rmSync(file)
    expect(verifyPulseToken(t)).toBeNull()

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revoked: [] }))
    vi.advanceTimersByTime(300) // past the remembered-failure window
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    // ...and the restored bundle is authoritative, including for revocation.
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, revoked: [{ jti: 'external-1', exp: base.exp }] }),
    )
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('keeps verifying inside the bounded grace window and hard-denies past it', () => {
    const t = mintRs256({ ...base, jti: 'grace-1' }, { kid: KID })
    // Both the grace stamp and its expiry must be read from the same (monotonic) fake
    // clock, so freeze before the first successful verification.
    vi.useFakeTimers({ toFake: ['Date', 'performance'], now: Date.now() })
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    // A /control outage with zero tolerance would lock every session out instantly;
    // the bounded window trades that for a loud, time-limited stale read.
    fs.rmSync(path.join(dir, 'revocations.json'))
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    vi.advanceTimersByTime(61_000)
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('accepts a healthy no-jti token but denies it when the denylist is unavailable', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '0'
    const t = mintRs256({ ...base }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    fs.rmSync(path.join(dir, 'revocations.json'))
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('rejects a token whose jti is present but blank', () => {
    expect(verifyPulseToken(mintRs256({ ...base, jti: '' }, { kid: KID }))).toBeNull()
    expect(verifyPulseToken(mintRs256({ ...base, jti: '   ' }, { kid: KID }))).toBeNull()
  })

  it('rejects a token when the denylist has a shape this reader does not understand', () => {
    const t = mintRs256({ ...base, jti: 'shape-1' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')

    // Parsed leniently this would be an EMPTY denylist, i.e. accept everything.
    fs.writeFileSync(path.join(dir, 'revocations.json'), JSON.stringify({ schemaVersion: 2, revoked: [] }))
    _clearCache()
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('rejects a wrong signature', () => {
    const t = mintRs256({ ...base }, { kid: KID }).slice(0, -2) + 'xx'
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('rejects a non-controlplane issuer', () => {
    expect(verifyPulseToken(mintRs256({ ...base, iss: 'other' }, { kid: KID }))).toBeNull()
  })

  it('rejects an expired token', () => {
    expect(
      verifyPulseToken(mintRs256({ ...base, exp: Math.floor(Date.now() / 1000) - 5 }, { kid: KID }))
    ).toBeNull()
  })

  it('rejects a revoked jti (offline revocation)', () => {
    const t = mintRs256({ ...base, jti: 'revoked-1' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')
    revokeJti('revoked-1', base.exp)
    _clearCache()
    expect(verifyPulseToken(t)).toBeNull()
  })

  // ── Dual-accept: RS256 (asymmetric) ───────────────────────────────────────────
  it('accepts a valid RS256 token signed by the hub private key (matching kid)', () => {
    const t = mintRs256({ ...base, jti: 'r1' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')
  })

  it('accepts a valid RS256 token with no kid (tries all published keys)', () => {
    const t = mintRs256({ ...base }, {})
    expect(verifyPulseToken(t)?.userId).toBe('u1')
  })

  it('accepts RS256 when the kid is unknown but a published key still verifies', () => {
    const t = mintRs256({ ...base }, { kid: 'some-unknown-kid' })
    expect(verifyPulseToken(t)?.userId).toBe('u1')
  })

  it('accepts a user/service token with the expected audience', () => {
    const t = mintRs256({ ...base, aud: 'finpulse', svc: 'retirementpulse' }, { kid: KID })
    expect(verifyPulseToken(t, { expectedAud: 'finpulse' })?.email).toBe('a@b.com')
    expect(verifyPulseToken(t, { expectedAud: 'propertypulse' })).toBeNull()
  })

  it('rejects job-shaped tokens unless the caller explicitly opts into the job purpose', () => {
    const t = mintRs256({ iss: 'controlplane', purpose: 'job', aud: 'finpulse', exp: base.exp }, { kid: KID })
    expect(verifyPulseToken(t)).toBeNull()
    expect(verifyPulseToken(t, { expectedAud: 'finpulse', expectedPurpose: 'job' })?.purpose).toBe('job')
  })

  it('rejects job tokens for the wrong audience', () => {
    const t = mintRs256({ iss: 'controlplane', purpose: 'job', aud: 'finpulse', exp: base.exp }, { kid: KID })
    expect(verifyPulseToken(t, { expectedAud: 'healthpulse', expectedPurpose: 'job' })).toBeNull()
  })

  it('rejects ordinary user tokens when a job token is required', () => {
    const t = mintRs256({ ...base, aud: 'finpulse' }, { kid: KID })
    expect(verifyPulseToken(t, { expectedAud: 'finpulse', expectedPurpose: 'job' })).toBeNull()
  })

  it('rejects an RS256 token signed by a different (wrong) private key', () => {
    const t = mintRs256({ ...base }, { key: WRONG_PRIV })
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('rejects an expired RS256 token', () => {
    const t = mintRs256({ ...base, exp: Math.floor(Date.now() / 1000) - 5 }, { kid: KID })
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('rejects a revoked RS256 jti', () => {
    const t = mintRs256({ ...base, jti: 'rs-revoked' }, { kid: KID })
    expect(verifyPulseToken(t)?.userId).toBe('u1')
    revokeJti('rs-revoked', base.exp)
    _clearCache()
    expect(verifyPulseToken(t)).toBeNull()
  })

  it('rejects an unsupported alg (e.g. none)', () => {
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const body = b64url(JSON.stringify(base))
    expect(verifyPulseToken(`${header}.${body}.`)).toBeNull()
  })

  it('REJECTS HS256 (retired in Stage 4 — RS256 only)', () => {
    const t = mintHubToken({ ...base, jti: 'hs-retired' })
    expect(verifyPulseToken(t)).toBeNull()
  })
})
