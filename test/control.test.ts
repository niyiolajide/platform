import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readAiSettings,
  publishAiSettings,
  aiConfigSource,
  isRevoked,
  revokeJti,
  publishRevocations,
  readRevocations,
  checkJtiRevocation,
  RevocationsUnavailableError,
  _clearCache,
  AI_SETTINGS_SCHEMA,
} from '../src/control'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'))
  process.env.CONTROL_DIR = dir
  delete process.env.ANTHROPIC_MODEL
  delete process.env.CONTROL_REVOCATIONS_GRACE_MS
  _clearCache()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.CONTROL_REVOCATIONS_GRACE_MS
})

// ── Helpers for the stable-read machinery ────────────────────────────────────
const future = () => Math.floor(Date.now() / 1000) + 3600
const revPath = () => path.join(dir, 'revocations.json')
const lockPath = () => `${revPath()}.lock`
const tmpLeftovers = () => fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))

function writeBundle(file: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value))
}

/**
 * Freeze BOTH clocks the reader can observe.
 *
 * The cache-staleness and grace deadlines are measured on the MONOTONIC clock
 * (`performance.now`) precisely so a wall-clock change cannot move them, so a test that
 * only moved `Date` would prove nothing. Install this BEFORE the read whose snapshot is
 * being aged: the stamp and the comparison must come from the same fake clock.
 */
function useFrozenClocks(): void {
  vi.useFakeTimers({ toFake: ['Date', 'performance'], now: Date.now() })
}

/**
 * Simulate a torn in-place rewrite: the reader fingerprints the file immediately
 * before and immediately after reading it, so making the SECOND stat of an attempt
 * disagree is exactly what a concurrent overwrite looks like from the reader's side.
 * Perturbs the first `times` attempts and then lets the file settle.
 */
function tearFirstAttempts(target: string, times: number): { statCalls: () => number } {
  const realStat = fs.statSync.bind(fs)
  let targetCalls = 0
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: object) => {
    const stat = realStat(p as string, opts as never) as fs.BigIntStats
    if (String(p) !== target) {return stat}
    targetCalls += 1
    const isAfterStat = targetCalls % 2 === 0
    if (isAfterStat && targetCalls / 2 <= times) {
      return { ...stat, mtimeNs: stat.mtimeNs + 1n }
    }
    return stat
  }) as typeof fs.statSync)
  return { statCalls: () => targetCalls }
}

/**
 * Simulate a torn read whose CONTENT is partial, not just whose metadata moved: an
 * in-place rewrite observed mid-write yields truncated bytes, i.e. a JSON SyntaxError.
 * Perturbing only `stat` (above) never exercises that path.
 */
function tearJsonFirstAttempts(target: string, times: number): { reads: () => number } {
  const realRead = fs.readFileSync.bind(fs)
  let targetReads = 0
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, opts?: object) => {
    if (String(p) !== target) {return realRead(p as string, opts as never)}
    targetReads += 1
    const whole = String(realRead(p as string, 'utf8'))
    return targetReads <= times ? whole.slice(0, Math.max(1, Math.floor(whole.length / 2))) : whole
  }) as typeof fs.readFileSync)
  return { reads: () => targetReads }
}

/** Pass-through stat counter, for proving how much filesystem work a read actually did. */
function countStats(target: string): { calls: () => number } {
  const realStat = fs.statSync.bind(fs)
  let calls = 0
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: object) => {
    if (String(p) === target) {calls += 1}
    return realStat(p as string, opts as never)
  }) as typeof fs.statSync)
  return { calls: () => calls }
}

describe('ai settings', () => {
  it('uses schema defaults when no file is present (env-default)', () => {
    expect(aiConfigSource()).toBe('env-default')
    const s = readAiSettings()
    // Legacy scalars are now derived from the default cascade (the source of truth):
    // main's first anthropic step, fast's first anthropic step.
    expect(s.anthropicModel).toBe('claude-sonnet-4-6')
    expect(s.anthropicModelFast).toBe('claude-haiku-4-5')
    expect(s.cascades.main[0]).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' })
    expect(s.dataPolicy.maskExternalRequests).toBe(true)
    expect(s.dataPolicy.externalProviders).toEqual(['gemini', 'anthropic'])
    expect(s.dataPolicy.domainRouting).toEqual([
      { domain: 'health', apps: ['healthpulse'], mode: 'local-only', fallback: 'deterministic' },
      { domain: 'finance', apps: ['finpulse', 'retirepulse', 'retirementpulse'], mode: 'local-only', fallback: 'deterministic' },
    ])
  })

  it('env defaults override schema defaults', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'
    _clearCache()
    expect(readAiSettings().anthropicModel).toBe('claude-opus-4-8')
  })

  it('published cascade is the source of truth; legacy scalars derive from it', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'
    publishAiSettings(
      AI_SETTINGS_SCHEMA.parse({
        cascades: {
          main: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
          fast: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
        },
      }),
    )
    _clearCache()
    expect(aiConfigSource()).toBe('file')
    const s = readAiSettings()
    // The published cascade wins over the ANTHROPIC_MODEL env default; the legacy
    // scalar is backfilled from the cascade's first anthropic step.
    expect(s.cascades.main[0].model).toBe('claude-haiku-4-5')
    expect(s.anthropicModel).toBe('claude-haiku-4-5')
  })

  it('synthesizes a cascade from a legacy ai.json that predates cascades', () => {
    // A file written by the OLD hub: legacy fields, no `cascades` key.
    fs.writeFileSync(
      path.join(dir, 'ai.json'),
      JSON.stringify({ schemaVersion: 1, provider: 'gemini', geminiModel: 'gemini-2.5-flash' }),
    )
    _clearCache()
    const s = readAiSettings()
    // Gemini-first (from legacy `provider`), with Claude + Ollama appended as fallback.
    expect(s.cascades.main[0].provider).toBe('gemini')
    expect(s.cascades.main.some((x) => x.provider === 'anthropic')).toBe(true)
    expect(s.cascades.main.some((x) => x.provider === 'ollama')).toBe(true)
  })

  it('tolerant read of an older schemaVersion with missing fields', () => {
    // Simulate a file written by an older hub: only a couple of fields.
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ schemaVersion: 0, provider: 'anthropic' }))
    _clearCache()
    const s = readAiSettings()
    // Missing fields fall back to schema defaults rather than throwing.
    expect(s.anthropicModel).toBe('claude-sonnet-4-6')
    expect(s.geminiModelFallback).toBe('gemini-2.5-flash-lite')
    expect(s.dataPolicy.maskExternalRequests).toBe(true)
  })

  it('does not memoize a failed read under the failed file mtime', () => {
    // A corrupt ai.json falls back to env/defaults, but that fallback must not be
    // memoized: otherwise repairing the file without moving its mtime would keep
    // serving stale defaults until a cache reset, making a transient outage sticky.
    useFrozenClocks()
    const aiFile = path.join(dir, 'ai.json')
    fs.writeFileSync(aiFile, '{ corrupt json')
    const mtime = new Date('2026-01-01T00:00:00Z')
    fs.utimesSync(aiFile, mtime, mtime)
    _clearCache()
    expect(readAiSettings().anthropicModel).toBe('claude-sonnet-4-6')

    // Repaired externally (an operator, a redeploy) with the mtime pinned: recovery
    // must come from re-reading, not from a test-only cache reset.
    fs.writeFileSync(aiFile, JSON.stringify({ schemaVersion: 1, anthropicModel: 'repaired-model' }))
    fs.utimesSync(aiFile, mtime, mtime)
    vi.advanceTimersByTime(300) // past the remembered-failure window
    expect(readAiSettings().anthropicModel).toBe('repaired-model')
  })

  it('publishes and reads custom data policy routing', () => {
    publishAiSettings(
      AI_SETTINGS_SCHEMA.parse({
        dataPolicy: {
          externalProviders: ['anthropic'],
          maskExternalRequests: true,
          domainRouting: [
            { domain: 'finance', apps: ['finpulse'], mode: 'local-only', fallback: 'deterministic' },
            { domain: 'journal', apps: ['lifepulse'], mode: 'external-allowed', fallback: 'deterministic' },
          ],
        },
      }),
    )
    _clearCache()
    expect(readAiSettings().dataPolicy).toEqual({
      externalProviders: ['anthropic'],
      maskExternalRequests: true,
      domainRouting: [
        { domain: 'finance', apps: ['finpulse'], mode: 'local-only', fallback: 'deterministic' },
        { domain: 'journal', apps: ['lifepulse'], mode: 'external-allowed', fallback: 'deterministic' },
      ],
    })
  })
})

describe('revocations', () => {
  it('fails closed when unavailable, then reports revoked jtis and prunes expired entries', () => {
    expect(() => readRevocations()).toThrowError(RevocationsUnavailableError)
    expect(checkJtiRevocation('abc')).toBe('unavailable')
    expect(isRevoked('abc')).toBe(true)

    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    expect(isRevoked('abc')).toBe(false)

    const exp = future()
    const past = Math.floor(Date.now() / 1000) - 10
    revokeJti('abc', exp)
    _clearCache()
    expect(isRevoked('abc')).toBe(true)
    // Publishing prunes already-expired entries.
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'abc', exp }, { jti: 'old', exp: past }] })
    _clearCache()
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['abc'])
  })

  // A denylist whose SHAPE we do not understand is the dangerous case: parsing it
  // leniently would yield an empty `revoked` array, i.e. silent acceptance of every
  // revoked token — a fail-open wearing a fail-closed label.
  const unknownShapes: [string, unknown][] = [
    ['an empty object', {}],
    ['a renamed list key', { schemaVersion: 1, revocations: [{ jti: 'abc', exp: 4102444800 }] }],
    ['a future bundle version', { schemaVersion: 2, revoked: [] }],
    ['an unrecognized extra key', { schemaVersion: 1, revoked: [], mode: 'disabled' }],
    ['a null list', { schemaVersion: 1, revoked: null }],
  ]
  for (const [label, bundle] of unknownShapes) {
    it(`refuses to treat ${label} as an empty denylist`, () => {
      writeBundle('revocations.json', bundle)
      expect(() => readRevocations()).toThrowError(RevocationsUnavailableError)
      expect(checkJtiRevocation('abc')).toBe('unavailable')
      expect(isRevoked('abc')).toBe(true)
    })
  }

  it('denies a present-but-blank jti and exempts only a genuinely absent one', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    // Documented exemption: ControlPlane's short-lived job/service tokens carry no jti.
    expect(checkJtiRevocation(undefined)).toBe('clear')
    expect(checkJtiRevocation(null)).toBe('clear')
    // A blank jti is not a shape any minter produces, and it can never be revoked.
    expect(checkJtiRevocation('')).toBe('revoked')
    expect(checkJtiRevocation('   ')).toBe('revoked')
    // ...and an absent jti is still denied when the denylist itself is unavailable.
    fs.rmSync(revPath())
    _clearCache()
    expect(checkJtiRevocation(undefined)).toBe('unavailable')
  })
})

describe('revocation read resilience', () => {
  it('retries a torn read and accepts the first stable snapshot', () => {
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'abc', exp: future() }] })
    _clearCache()
    const probe = tearFirstAttempts(revPath(), 2)

    expect(checkJtiRevocation('abc')).toBe('revoked')
    // 3 attempts x (before + after) - the last attempt is the one that settled.
    expect(probe.statCalls()).toBe(6)
  })

  it('retries a PARTIAL-CONTENT torn read, not just moved metadata', () => {
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'abc', exp: future() }] })
    _clearCache()
    // Truncated bytes on the first two attempts: a JSON SyntaxError, which is what a
    // reader actually observes mid in-place-rewrite.
    const probe = tearJsonFirstAttempts(revPath(), 2)

    expect(checkJtiRevocation('abc')).toBe('revoked')
    expect(probe.reads()).toBe(3) // two torn attempts, then the settled one
  })

  it('does not re-pay the retry budget on every read during a persistent failure', () => {
    // Zero-tolerance retrying is its own outage: a synchronous backoff per verification
    // blocks the event loop for tens of ms per request exactly when auth is degraded.
    useFrozenClocks()
    fs.writeFileSync(revPath(), '{ "schemaVersion": 1, "revoked": [')
    const probe = countStats(revPath())

    expect(checkJtiRevocation('abc')).toBe('unavailable')
    const afterFirst = probe.calls()
    // One stat per attempt: the parse throws before the confirming post-read stat.
    expect(afterFirst).toBe(3)

    expect(checkJtiRevocation('abc')).toBe('unavailable')
    expect(checkJtiRevocation('abc')).toBe('unavailable')
    expect(probe.calls()).toBe(afterFirst) // remembered failure: no new filesystem work

    // ...but only briefly, so recovery is still noticed promptly.
    vi.advanceTimersByTime(300)
    expect(checkJtiRevocation('abc')).toBe('unavailable')
    expect(probe.calls()).toBeGreaterThan(afterFirst)
  })

  it('recovers from an EXTERNALLY restored bundle, with no cache invalidation hook', () => {
    useFrozenClocks()
    publishRevocations({ schemaVersion: 1, revoked: [] })
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '0'
    expect(checkJtiRevocation('abc')).toBe('clear')

    fs.rmSync(revPath())
    expect(checkJtiRevocation('abc')).toBe('unavailable')

    // Restored by something OUTSIDE this process (an operator, a redeploy, the real
    // ControlPlane in-place publisher) - nothing calls invalidateReadCache for us.
    writeBundle('revocations.json', { schemaVersion: 1, revoked: [{ jti: 'abc', exp: future() }] })
    vi.advanceTimersByTime(300) // past the remembered-failure window
    expect(checkJtiRevocation('abc')).toBe('revoked')
  })

  it('honors the retry budget and then fails closed', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    _clearCache()
    // Never settles: every attempt observes the file changing underneath it.
    const probe = tearFirstAttempts(revPath(), Number.MAX_SAFE_INTEGER)

    expect(checkJtiRevocation('abc')).toBe('unavailable')
    // Exactly the budget for that one call - proves the attempts are real and
    // bounded. A single-attempt reader would show 2 here, and an unbounded one
    // would never terminate at 6.
    expect(probe.statCalls()).toBe(6)
    expect(isRevoked('abc')).toBe(true)
  })

  it('sees an external publication without a cache reset', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')

    // Written directly, so nothing invalidates the cache for us - the fingerprint
    // check is the only thing that can notice.
    writeBundle('revocations.json', { schemaVersion: 1, revoked: [{ jti: 'abc', exp: future() }] })
    expect(checkJtiRevocation('abc')).toBe('revoked')
  })

  it('bounds cache staleness when the fingerprint cannot change', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })

    // Coarse-mtime filesystem: a same-size in-place rewrite inside one timestamp tick
    // is invisible to the fingerprint. Freeze the stat to reproduce that exactly.
    const frozen = fs.statSync(revPath(), { bigint: true })
    const realStat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: object) =>
      String(p) === revPath() ? frozen : realStat(p as string, opts as never)) as typeof fs.statSync)
    // Freeze the clock BEFORE the snapshot is cached so the TTL boundary is exact
    // rather than a race against wall-clock time.
    useFrozenClocks()
    expect(checkJtiRevocation('abc')).toBe('clear')

    writeBundle('revocations.json', { schemaVersion: 1, revoked: [{ jti: 'abc', exp: future() }] })
    expect(checkJtiRevocation('abc')).toBe('clear') // still inside the cache TTL

    vi.advanceTimersByTime(1_500)
    expect(checkJtiRevocation('abc')).toBe('revoked') // TTL forced a re-read
  })

  it('defaults to denial after retries when a previously valid bundle becomes unavailable', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    fs.rmSync(revPath())
    expect(checkJtiRevocation('abc')).toBe('unavailable')
    expect(isRevoked('abc')).toBe(true)
  })

  it('serves a bounded last-known-good snapshot during an outage, then hard-denies', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '60000'
    useFrozenClocks()
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear') // validated: eligible for grace

    fs.rmSync(revPath())
    expect(checkJtiRevocation('abc')).toBe('clear') // replayed inside the grace window

    vi.advanceTimersByTime(61_000)
    expect(checkJtiRevocation('abc')).toBe('unavailable')
    expect(isRevoked('abc')).toBe(true)
  })

  it('measures the grace window on a clock a wall-clock rollback cannot wind back', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '60000'
    useFrozenClocks()
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    fs.rmSync(revPath())

    // NTP correction / an operator fixing a drifted host: wall clock jumps BACKWARD.
    // Measured on Date.now() this makes the snapshot's age negative, so the 60s bound
    // would never be reached and the grace window would extend indefinitely.
    vi.setSystemTime(new Date(Date.now() - 120_000))
    expect(checkJtiRevocation('abc')).toBe('clear') // still genuinely inside the window

    vi.advanceTimersByTime(61_000)
    expect(checkJtiRevocation('abc')).toBe('unavailable') // bound held regardless
  })

  it('never graces a snapshot this process has not itself validated', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '60000'
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    fs.rmSync(revPath())

    _clearCache() // stand-in for a fresh process: no last-known-good to replay
    expect(checkJtiRevocation('abc')).toBe('unavailable')
  })

  it('does not replay a pre-publication snapshot after a successful write', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '60000'
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    revokeJti('abc', future())
    // The publication supersedes the clear snapshot; losing the file now must not
    // resurrect it and un-revoke the token.
    fs.rmSync(revPath())
    expect(checkJtiRevocation('abc')).not.toBe('clear')
  })

  it('honors an operator-configured grace window and its ceiling', () => {
    useFrozenClocks()
    process.env.CONTROL_REVOCATIONS_GRACE_MS = '0'
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    fs.rmSync(revPath())
    expect(checkJtiRevocation('abc')).toBe('unavailable') // grace disabled

    process.env.CONTROL_REVOCATIONS_GRACE_MS = '99999999' // clamped to the 60s ceiling
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(checkJtiRevocation('abc')).toBe('clear')
    fs.rmSync(revPath())
    vi.advanceTimersByTime(61_000)
    expect(checkJtiRevocation('abc')).toBe('unavailable')
  })

  it('warns instead of silently widening the window when the value is unusable', () => {
    process.env.CONTROL_REVOCATIONS_GRACE_MS = 'not-a-number'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    publishRevocations({ schemaVersion: 1, revoked: [] })

    expect(checkJtiRevocation('abc')).toBe('clear')
    // A typo in a security-posture knob must not look like a deliberate setting.
    expect(
      warn.mock.calls.some((c) => String(c[1]).includes('CONTROL_REVOCATIONS_GRACE_MS')),
    ).toBe(true)
    // A typo must not opt into stale-token acceptance.
    fs.rmSync(revPath())
    expect(checkJtiRevocation('abc')).toBe('unavailable')
  })
})

describe('revocation publication', () => {
  it('publishes the first revocation on a fresh volume', () => {
    // A brand-new deployment has no bundle. Refusing here would make the very first
    // revocation impossible through the normal API - a total, unfixable auth outage.
    expect(fs.existsSync(revPath())).toBe(false)
    revokeJti('first', future())
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['first'])
  })

  it('refuses to clobber a denylist it cannot read, and leaves no temp file', () => {
    const corrupt = '{ "schemaVersion": 1, "revoked": [ { "jti": "keep-me"'
    fs.writeFileSync(revPath(), corrupt)

    expect(() => revokeJti('new-one', future())).toThrowError(RevocationsUnavailableError)
    // Bootstrapping here would silently drop every revocation the file still holds.
    expect(fs.readFileSync(revPath(), 'utf8')).toBe(corrupt)
    expect(tmpLeftovers()).toEqual([])
  })

  it('does not lose a revocation published concurrently (compare-and-set)', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realFsync = fs.fsyncSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (!injected) {
        injected = true
        // Another publisher lands between our read and our rename. Without the CAS
        // our rename would win and 'other' would be lost forever.
        writeBundle('revocations.json', {
          schemaVersion: 1,
          revoked: [{ jti: 'other', exp: future() }],
        })
      }
      realFsync(fd)
    })

    revokeJti('mine', future())
    expect(readRevocations().revoked.map((r) => r.jti).sort()).toEqual(['mine', 'other'])
    expect(tmpLeftovers()).toEqual([])
  })

  it('does not lose an in-place revocation that lands after the pre-rename check', () => {
    // The exact TASK-11351 repro: a non-locking in-place publisher (ControlPlane's
    // writeControlJson, which cannot temp+rename under exact-file binds) landing
    // after the final pre-rename check but before the rename itself. A bare
    // check-then-rename reports success while silently erasing 'other'.
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realRename = fs.renameSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!injected) {
        injected = true
        writeBundle('revocations.json', {
          schemaVersion: 1,
          revoked: [{ jti: 'other', exp: future() }],
        })
      }
      return realRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    revokeJti('mine', future())
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti).sort()).toEqual(['mine', 'other'])
    expect(tmpLeftovers()).toEqual([])
    expect(fs.readdirSync(dir).filter((f) => f.includes('.casbackup-'))).toEqual([])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('retries instead of reporting success when a rename-based publisher lands after our rename', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realRename = fs.renameSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      const result = realRename(oldPath, newPath)
      // A rename-based publisher landing after our rename replaces our inode: the
      // live path no longer holds what we published, so success must not be reported.
      if (!injected && String(newPath) === revPath()) {
        injected = true
        const staged = `${revPath()}.injected-${process.pid}`
        fs.writeFileSync(
          staged,
          JSON.stringify({ schemaVersion: 1, revoked: [{ jti: 'other', exp: future() }] }),
        )
        realRename(staged, newPath)
      }
      return result
    }) as typeof fs.renameSync)

    revokeJti('mine', future())
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti).sort()).toEqual(['mine', 'other'])
    expect(tmpLeftovers()).toEqual([])
  })

  it('does not clobber a concurrent first publisher on a fresh volume', () => {
    // Bootstrap must be an atomic create, not a check-then-rename: a publisher that
    // creates the file between our absent-probe and our write must fail our write
    // (so we merge onto theirs) rather than be silently replaced by it.
    expect(fs.existsSync(revPath())).toBe(false)
    const realLink = fs.linkSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'linkSync').mockImplementation(((existing: fs.PathLike, created: fs.PathLike) => {
      if (!injected) {
        injected = true
        writeBundle('revocations.json', {
          schemaVersion: 1,
          revoked: [{ jti: 'other', exp: future() }],
        })
      }
      return realLink(existing, created)
    }) as typeof fs.linkSync)

    revokeJti('mine', future())
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti).sort()).toEqual(['mine', 'other'])
    expect(tmpLeftovers()).toEqual([])
  })

  it('catches a same-size in-place landing invisible to a coarse fingerprint', () => {
    // Same-length jtis so the competing bundle is byte-identical in size, plus a
    // frozen timestamp: the fingerprint provably cannot move, so only a CONTENT
    // compare can notice the concurrent write. A fingerprint-only CAS loses 'bbbb'.
    const exp = future()
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'aaaa', exp }] })
    const frozen = fs.statSync(revPath(), { bigint: true })
    const realStat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: object) => {
      const stat = realStat(p as string, opts as never) as fs.BigIntStats
      if (String(p) === revPath() && (opts as { bigint?: boolean } | undefined)?.bigint === true) {
        return { ...stat, mtimeNs: frozen.mtimeNs, ctimeNs: frozen.ctimeNs, size: frozen.size }
      }
      return stat
    }) as typeof fs.statSync)
    const realRename = fs.renameSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!injected) {
        injected = true
        writeBundle('revocations.json', { schemaVersion: 1, revoked: [{ jti: 'bbbb', exp }] })
      }
      return realRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    revokeJti('mine', future())
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti).sort()).toEqual(['aaaa', 'bbbb', 'mine'])
  })

  it('short-circuits an idempotent re-revocation with zero writes', () => {
    // Re-revoking a jti that is already live (and adds nothing unmerged) must
    // publish nothing: no stage, no rename — both for hot-path cost and to
    // avoid widening the race window with writes that change nothing. (The
    // attempt still takes and releases a history pin via link/unlink; only the
    // rename count is asserted here.)
    revokeJti('dup', future())
    const before = fs.readFileSync(revPath(), 'utf8')
    const realRename = fs.renameSync.bind(fs)
    let renames = 0
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      renames += 1
      return realRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    revokeJti('dup', future())
    expect(renames).toBe(0)
    expect(fs.readFileSync(revPath(), 'utf8')).toBe(before)
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['dup'])
  })

  it('refuses a replacement that changes inode between the history pin and its fingerprint', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realLink = fs.linkSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'linkSync').mockImplementation(((existing: fs.PathLike, created: fs.PathLike) => {
      realLink(existing, created)
      if (!injected && String(existing) === revPath()) {
        injected = true
        const replacement = `${revPath()}.concurrent`
        fs.writeFileSync(replacement, JSON.stringify({
          schemaVersion: 1, revoked: [{ jti: 'other', exp: future() }],
        }))
        fs.renameSync(replacement, revPath())
      }
    }) as typeof fs.linkSync)

    expect(() => publishRevocations({ schemaVersion: 1, revoked: [] }))
      .toThrowError(/moved while pinning/)
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['other'])
    expect(tmpLeftovers()).toEqual([])
    expect(fs.readdirSync(dir).filter((f) => f.includes('.casbackup-'))).toEqual([])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('releases the history pin and lock when staging a replacement fails', () => {
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'kept', exp: future() }] })
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('stage failed') })
    expect(() => publishRevocations({ schemaVersion: 1, revoked: [] }))
      .toThrowError(/stage failed/)
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['kept'])
    expect(tmpLeftovers()).toEqual([])
    expect(fs.readdirSync(dir).filter((f) => f.includes('.casbackup-'))).toEqual([])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('refuses a replace whose pre-rename check observes a concurrent landing', () => {
    // publishRevocations is replace-semantics, but never blind and never
    // silently winning: an in-place publisher landing between its probe and its
    // rename throws a loud conflict instead of erasing the landing. Retrying
    // the same replace would erase it while claiming operator intent, so the
    // only honest recovery is re-issuing the replace knowingly.
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realFsync = fs.fsyncSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (!injected) {
        injected = true
        writeBundle('revocations.json', {
          schemaVersion: 1,
          revoked: [{ jti: 'other', exp: future() }],
        })
      }
      realFsync(fd)
    })

    // The concurrent revocation survives: our replace threw rather than
    // overwriting state this call never observed.
    expect(() =>
      publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'op', exp: future() }] }),
    ).toThrowError(/moved before our rename/)
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['other'])
    expect(tmpLeftovers()).toEqual([])
  })

  it('throws instead of silently erasing an in-place revocation landing after the pre-rename check', () => {
    // Replace-path analog of the merge path's TASK-11351 repro: a non-locking
    // in-place publisher landing after the final pre-rename check but before
    // the rename itself. live===next after our rename proves only that OUR
    // write landed — the history pin (same inode as live until the rename
    // orphans it) is what still observes the landing. A replace can never
    // re-merge (that would corrupt un-revoke by omission), so the honest
    // recovery is a loud conflict, never a success that erased 'other'.
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realRename = fs.renameSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!injected) {
        injected = true
        writeBundle('revocations.json', {
          schemaVersion: 1,
          revoked: [{ jti: 'other', exp: future() }],
        })
      }
      return realRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    expect(() =>
      publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'op', exp: future() }] }),
    ).toThrowError(/landed inside our replace window/)
    expect(injected).toBe(true)
    // Loud, not silent: our rename still won the race (the operator re-issues
    // knowingly), but success was NOT reported over the erased landing.
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['op'])
    expect(tmpLeftovers()).toEqual([])
    expect(fs.readdirSync(dir).filter((f) => f.includes('.casbackup-'))).toEqual([])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('throws on an in-place landing invisible to a coarse fingerprint', () => {
    // Replace-path content proof: frozen timestamps and size mean the
    // fingerprint provably cannot move, so only the pin/base CONTENT compare
    // can notice the concurrent write. Without it, live===next after our
    // rename would report success over the erased landing.
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const frozen = fs.statSync(revPath(), { bigint: true })
    const realStat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: object) => {
      const stat = realStat(p as string, opts as never) as fs.BigIntStats
      if (String(p) === revPath() && (opts as { bigint?: boolean } | undefined)?.bigint === true) {
        return { ...stat, mtimeNs: frozen.mtimeNs, ctimeNs: frozen.ctimeNs, size: frozen.size }
      }
      return stat
    }) as typeof fs.statSync)
    const realRename = fs.renameSync.bind(fs)
    let injected = false
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!injected) {
        injected = true
        writeBundle('revocations.json', { schemaVersion: 1, revoked: [{ jti: 'bbbb', exp: future() }] })
      }
      return realRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    expect(() =>
      publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'oppp', exp: future() }] }),
    ).toThrowError(/landed inside our replace window/)
    expect(injected).toBe(true)
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['oppp'])
    expect(tmpLeftovers()).toEqual([])
    expect(fs.readdirSync(dir).filter((f) => f.includes('.casbackup-'))).toEqual([])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('supports un-revoke by omission via publishRevocations', () => {
    // Replace intent includes shrinking: removing an unexpired jti from the
    // published list is the operator's deliberate un-revoke and must succeed
    // with no concurrency involved.
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'a', exp: future() }] })
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['a'])
    publishRevocations({ schemaVersion: 1, revoked: [] })
    expect(readRevocations().revoked).toEqual([])
    expect(tmpLeftovers()).toEqual([])
  })

  it('does not unlink a successor publication lock taken after a stale break', () => {
    // Mutual exclusion is per-lockfile-content, not per-path: if our lock is broken
    // as stale mid-operation and a successor takes it, our release must leave their
    // lock in place. Unconditional cleanup deletes the SUCCESSOR's exclusion.
    publishRevocations({ schemaVersion: 1, revoked: [] })
    const realRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      fs.writeFileSync(lockPath(), 'successor-token\n')
      return realRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    revokeJti('mine', future())
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['mine'])
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe('successor-token\n')
  })

  it('serializes publication under an exclusive lock', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    // A CAS alone cannot close the check->rename window, because rename replaces
    // unconditionally. The lock is what actually serializes publishers, so a held lock
    // must stop this publication rather than let it race.
    fs.writeFileSync(lockPath(), 'held by another publisher\n')

    expect(() => revokeJti('blocked', future())).toThrowError(/lock/i)
    expect(readRevocations().revoked).toEqual([])
    expect(tmpLeftovers()).toEqual([])

    // Our own lock must not leak once the publication finishes.
    fs.rmSync(lockPath())
    revokeJti('allowed', future())
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['allowed'])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('breaks a lock abandoned by a crashed publisher', () => {
    publishRevocations({ schemaVersion: 1, revoked: [] })
    fs.writeFileSync(lockPath(), 'pid of a process that died\n')
    // Backdate it past the staleness bound: a crash must not wedge revocation forever.
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath(), old, old)

    revokeJti('after-crash', future())
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['after-crash'])
    expect(fs.existsSync(lockPath())).toBe(false)
  })

  it('validates the caller payload before pruning rebuilds it', () => {
    // Pruning rebuilds {schemaVersion: 1, revoked: filtered}, which would launder an
    // unknown shape into a valid-looking v1 bundle. A JS caller passing a v2 payload
    // whose revocations live under another key must NOT publish an empty denylist.
    const v2 = {
      schemaVersion: 2,
      revoked: [],
      revocations: [{ jti: 'still-revoked', exp: future() }],
    }
    expect(() => publishRevocations(v2 as never)).toThrowError()
    expect(fs.existsSync(revPath())).toBe(false)
  })
})

describe('optional bundles', () => {
  it('retries a torn optional bundle instead of silently falling back to env defaults', () => {
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({}))
    _clearCache()
    // Partial CONTENT, so this cannot pass against a reader that stats once and parses
    // whatever it got: the first two attempts raise a SyntaxError.
    const probe = tearJsonFirstAttempts(path.join(dir, 'ai.json'), 2)

    // Reporting env-default for a file that exists is a real (if quieter) drift bug.
    expect(aiConfigSource()).toBe('file')
    expect(probe.reads()).toBe(3) // it genuinely retried rather than shrugging
  })
})
