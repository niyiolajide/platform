import fs from 'fs'
import path from 'path'
import { getLogger } from '../config'

// ── Stable control-file reads ─────────────────────────────────────────────────
// Production publishes some control bundles with an IN-PLACE overwrite (under the
// exact-file binds the apps ship, the container UID cannot create a temp file in the
// root-owned /control, so temp+rename is not available). An in-place rewrite is not
// atomic for readers: a concurrent read can observe a truncated or half-rewritten
// file. Everything here exists to make that observable rather than silently wrong —
// a snapshot is accepted only when the file's metadata is identical immediately
// before and immediately after the read, and a rejected snapshot is never cached.

export interface FileFingerprint {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/**
 * Why a read failed. Callers need this: an ABSENT bundle is a deployment state a
 * writer may legitimately bootstrap from, while parse/schema/permission failures
 * mean real content exists that we must not clobber or ignore.
 */
export type ReadFailureClass =
  | 'absent' // ENOENT — the file genuinely is not there
  | 'permission' // EACCES/EPERM — mounted but unreadable
  | 'io' // any other filesystem error
  | 'parse' // not JSON (classically: a torn in-place rewrite)
  | 'schema' // JSON, but not a shape this reader understands
  | 'unstable' // the file changed underneath the read

export type StableRead<T> =
  | { ok: true; stale: false; value: T; fingerprint: FileFingerprint }
  | { ok: true; stale: true; value: T; ageMs: number }
  | { ok: false; failure: ReadFailureClass; error: unknown; attempts: number }

export interface StableReadOptions<T> {
  /** Bounded retry budget for transient failures (torn read, unstable metadata). */
  attempts?: number
  /** Delay before each retry, indexed by completed attempt. */
  backoffMs?: readonly number[]
  /**
   * Bounded last-known-good window: once the retry budget is spent, a snapshot THIS
   * process already validated may be served for this many ms, flagged `stale`. 0 = off.
   */
  graceMs?: number
  logFailure?: boolean
  validate?: (value: unknown) => T
}

interface CacheEntry {
  fingerprint: FileFingerprint
  value: unknown
  readAtMs: number
}

interface LastGoodEntry {
  value: unknown
  validatedAtMs: number
}

interface FailureEntry {
  failure: ReadFailureClass
  error: unknown
  attempts: number
  failedAtMs: number
}

/**
 * Elapsed-time source for every deadline here. MONOTONIC on purpose: a backward
 * wall-clock jump (NTP, an operator fixing a drifted host) must not be able to extend
 * the grace window or the cache bound — both are security deadlines.
 */
const elapsedMs = (): number => performance.now()

type ReadAttempt<T> = { ok: true; value: T; raw: unknown } | { ok: false; error: unknown }

/**
 * Bound how long an unchanged-looking file may be served from cache. The fingerprint is
 * exact at nanosecond resolution, but a same-size in-place rewrite within one timestamp
 * tick is invisible on a coarse-mtime filesystem. Re-reading at most once a second caps
 * that staleness at ~1s for one extra readFileSync per second per file.
 */
const CACHE_TTL_MS = 1_000

/**
 * How long a TERMINAL read failure is remembered. Without it, a persistently unreadable
 * bundle re-pays the whole retry budget — including its synchronous backoff — on every
 * verification, stalling the event loop precisely during an incident. Kept to a fraction
 * of a second so recovery is still noticed promptly; a remembered failure only ever
 * routes to the grace/deny path, never to a fresh accept.
 */
const FAILURE_TTL_MS = 250

class UnstableSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnstableSnapshotError'
  }
}

const cache = new Map<string, CacheEntry>()
const lastGood = new Map<string, LastGoodEntry>()
const failures = new Map<string, FailureEntry>()
const controlDir = () => process.env.CONTROL_DIR ?? '/control'

function fingerprint(s: fs.BigIntStats): FileFingerprint {
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs }
}

export function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

/**
 * Current fingerprint of a control file.
 *
 * Three-way ON PURPOSE. A compare-and-set that treats "I could not stat it" as "it is
 * absent" would let a bootstrap write clobber a file another publisher had just
 * created; the caller must be able to fail closed on `error` instead.
 */
export type FingerprintProbe =
  | { kind: 'present'; fingerprint: FileFingerprint }
  | { kind: 'absent' }
  | { kind: 'error'; error: unknown }

export function probeFingerprint(file: string): FingerprintProbe {
  try {
    return {
      kind: 'present',
      fingerprint: fingerprint(fs.statSync(path.join(controlDir(), file), { bigint: true })),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {return { kind: 'absent' }}
    return { kind: 'error', error }
  }
}

function classify(error: unknown): ReadFailureClass {
  if (error instanceof UnstableSnapshotError) {return 'unstable'}
  if (error instanceof SyntaxError) {return 'parse'}
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {return 'absent'}
  if (code === 'EACCES' || code === 'EPERM') {return 'permission'}
  if (typeof code === 'string') {return 'io'}
  // No errno and not a JSON syntax error: the validator rejected the payload.
  return 'schema'
}

/**
 * A retry only helps a failure a re-read could plausibly resolve. An absent or unreadable
 * file is a deterministic deployment state — retrying burns hot-path latency for nothing.
 */
function isRetryable(failure: ReadFailureClass): boolean {
  return failure !== 'absent' && failure !== 'permission'
}

function backoffFor(backoffMs: readonly number[], completedAttempt: number): number {
  return completedAttempt <= backoffMs.length ? backoffMs[completedAttempt - 1] : 0
}

const sleepSlot = (() => {
  try {
    return new Int32Array(new SharedArrayBuffer(4))
  } catch {
    return null
  }
})()

/**
 * Synchronous backoff. These readers are synchronous by contract (apps call them
 * from non-async auth paths), so the wait has to be synchronous too. It is only ever
 * reached after a failed attempt, never on the healthy path.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0 || sleepSlot == null) {return}
  Atomics.wait(sleepSlot, 0, 0, ms)
}

function readCached<T>(
  file: string,
  full: string,
  before: FileFingerprint,
  validate: (value: unknown) => T,
): ReadAttempt<T> | null {
  const hit = cache.get(file)
  if (!hit || !sameFingerprint(hit.fingerprint, before)) {return null}
  if (elapsedMs() - hit.readAtMs > CACHE_TTL_MS) {return null}
  try {
    const value = validate(hit.value)
    const after = fingerprint(fs.statSync(full, { bigint: true }))
    if (!sameFingerprint(before, after)) {
      throw new UnstableSnapshotError('control file changed while its cached snapshot was checked')
    }
    return { ok: true, value, raw: hit.value }
  } catch (error) {
    cache.delete(file)
    return { ok: false, error }
  }
}

function readFresh<T>(
  file: string,
  full: string,
  before: FileFingerprint,
  validate: (value: unknown) => T,
): ReadAttempt<T> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(full, 'utf8'))
    const value = validate(raw)
    const after = fingerprint(fs.statSync(full, { bigint: true }))
    if (!sameFingerprint(before, after)) {
      throw new UnstableSnapshotError('control file changed while it was being read')
    }
    cache.set(file, { fingerprint: after, value: raw, readAtMs: elapsedMs() })
    return { ok: true, value, raw }
  } catch (error) {
    return { ok: false, error }
  }
}

function serveLastGood<T>(
  file: string,
  graceMs: number,
  validate: (value: unknown) => T,
): { value: T; ageMs: number } | null {
  if (graceMs <= 0) {return null}
  const good = lastGood.get(file)
  if (!good) {return null}
  const ageMs = elapsedMs() - good.validatedAtMs
  if (ageMs > graceMs) {
    // Past the window, drop it so it can never be resurrected by a later clock read.
    lastGood.delete(file)
    return null
  }
  try {
    return { value: validate(good.value), ageMs }
  } catch {
    return null
  }
}

/**
 * The bounded attempt loop: either a fresh validated snapshot, or the terminal failure
 * the whole budget ended on. Retries only the classes a re-read could resolve.
 */
function attemptStableRead<T>(
  file: string,
  options: StableReadOptions<T>,
  validate: (value: unknown) => T,
): (StableRead<T> & { ok: true }) | FailureEntry {
  const full = path.join(controlDir(), file)
  const attempts = Math.max(1, options.attempts ?? 1)
  const backoffMs = options.backoffMs ?? []
  let lastError: unknown
  let lastFailure: ReadFailureClass = 'io'
  let used = 0

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    used = attempt
    let before: FileFingerprint
    try {
      before = fingerprint(fs.statSync(full, { bigint: true }))
    } catch (err) {
      lastError = err
      lastFailure = classify(err)
      if (!isRetryable(lastFailure)) {break}
      if (attempt < attempts) {sleepSync(backoffFor(backoffMs, attempt))}
      continue
    }

    const cached = readCached(file, full, before, validate)
    const result = cached ?? readFresh(file, full, before, validate)
    if (result.ok) {
      lastGood.set(file, { value: result.raw, validatedAtMs: elapsedMs() })
      failures.delete(file)
      return { ok: true, stale: false, value: result.value, fingerprint: before }
    }
    lastError = result.error
    lastFailure = classify(result.error)
    if (!isRetryable(lastFailure)) {break}
    if (attempt < attempts) {sleepSync(backoffFor(backoffMs, attempt))}
  }
  return { failure: lastFailure, error: lastError, attempts: used, failedAtMs: elapsedMs() }
}

/**
 * Read, parse, and validate a stable control-file snapshot.
 *
 * Accepts a snapshot only when the file's metadata is unchanged from immediately
 * before to immediately after the read; failures are never cached. Security-critical
 * callers can add bounded retries with backoff and a bounded last-known-good grace
 * window. The grace window only ever replays a snapshot THIS process already read and
 * validated — an absent or never-valid bundle can never be graced into existence.
 */
export function readStable<T = unknown>(
  file: string,
  options: StableReadOptions<T> = {},
): StableRead<T> {
  const validate = options.validate ?? ((value: unknown) => value as T)

  // A failure this recent has already spent the whole retry budget; spending it again
  // per request is what turns an outage into an event-loop stall.
  const recent = failures.get(file)
  const remembered =
    recent != null && elapsedMs() - recent.failedAtMs <= FAILURE_TTL_MS ? recent : null

  const outcome = remembered ?? attemptStableRead(file, options, validate)
  if ('ok' in outcome) {return outcome}
  if (remembered == null) {failures.set(file, outcome)}

  const { failure: lastFailure, error: lastError, attempts: used } = outcome
  const graced = serveLastGood(file, options.graceMs ?? 0, validate)
  if (graced) {
    return { ok: true, stale: true, value: graced.value, ageMs: graced.ageMs }
  }

  // An absent optional bundle is an ordinary state, not an incident; everything else
  // names the failure class so an operator can tell a torn write from a bad mount.
  if (lastFailure !== 'absent' && options.logFailure !== false) {
    getLogger().warn(
      { err: lastError, file, attempts: used, failure: lastFailure },
      '[control] failed to read a stable, valid control file snapshot',
    )
  }
  return { ok: false, failure: lastFailure, error: lastError, attempts: used }
}

/** Convenience wrapper for tolerant callers: a failed read is indistinguishable from absent. */
export function readRaw<T = unknown>(file: string, options: StableReadOptions<T> = {}): T | null {
  const result = readStable<T>(file, options)
  return result.ok ? result.value : null
}

export function invalidateReadCache(file: string): void {
  cache.delete(file)
  // A publication supersedes the pre-write snapshot: replaying it inside the grace
  // window could serve a denylist that predates the revocation just written.
  lastGood.delete(file)
  // The bundle just changed, so a remembered failure is stale evidence — drop it or a
  // successful republication would keep denying for the rest of the failure window.
  failures.delete(file)
}

export function clearReadCache(): void {
  cache.clear()
  lastGood.clear()
  failures.clear()
}
