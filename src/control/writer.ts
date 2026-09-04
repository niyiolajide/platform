import fs from 'fs'
import path from 'path'
import {
  invalidateReadCache,
  probeFingerprint,
  sameFingerprint,
  sleepSync,
  type FileFingerprint,
} from './reader'

// ── Control-bundle publication (hub only) ─────────────────────────────────────
// Only the hub mounts /control read-write. Writes here are temp + fsync + rename so
// readers never observe a partial bundle. (The ControlPlane web container cannot use
// this path — under its exact-file binds the root-owned /control rejects temp-file
// creation for UID 1001, so it publishes with its own in-place overwrite. That is
// precisely why the reader side validates snapshot stability; see reader.ts.)

const CONTROL_DIR = (): string => process.env.CONTROL_DIR ?? '/control'

let tmpCounter = 0

/** Best-effort directory fsync so a completed rename survives a crash. */
function fsyncDir(dir: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Unsupported on some platforms/mounts — durability of the rename itself is
    // still the filesystem's job; this is an extra guarantee, not a correctness one.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

function matchesExpected(file: string, expected: FileFingerprint | null): boolean {
  const probe = probeFingerprint(file)
  // Cannot tell what is there → refuse the write. Treating an EACCES/EIO stat as
  // "still absent" would let a bootstrap overwrite a bundle another publisher created.
  if (probe.kind === 'error') {return false}
  if (expected === null) {return probe.kind === 'absent'}
  return probe.kind === 'present' && sameFingerprint(probe.fingerprint, expected)
}

// ── Publication mutual exclusion ──────────────────────────────────────────────
// A fingerprint compare-and-set narrows the read-modify-write race but cannot close
// it: POSIX `rename` is an unconditional atomic REPLACE, so between "the fingerprint
// still matches" and "rename" a competing publisher can still land and be overwritten.
// An O_EXCL lockfile is what actually serializes publishers, so the compare happens
// under exclusion and the CAS becomes a second line of defence (it still catches a
// writer that does NOT take the lock).
const LOCK_ACQUIRE_ATTEMPTS = 50
const LOCK_RETRY_MS = 10
/** A lock older than this is assumed to belong to a crashed publisher. */
const LOCK_STALE_MS = 10_000

/** Best-effort unlink; losing the race to another cleaner is fine, we just retry. */
function unlinkIfPossible(target: string): void {
  try {
    fs.unlinkSync(target)
  } catch {
    /* already gone */
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    // Wall clock is unavoidable here (mtime IS wall clock). A backward clock jump only
    // makes a stale lock look fresh, which delays publication rather than corrupting
    // it — the fail-closed direction.
    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch {
    return false // vanished under us: not stale, just gone — retry the open
  }
}

/**
 * Run `fn` holding an exclusive publication lock for `file` (hub only).
 *
 * Only serializes publishers that go through this helper. ControlPlane's web container
 * publishes revocations with its own in-place overwrite (it cannot create files in the
 * root-owned /control under its exact-file binds), so it does NOT take this lock —
 * which is exactly why the reader validates snapshot stability and the write keeps its
 * compare-and-set.
 */
export function withControlLock<T>(file: string, fn: () => T): T {
  const dir = CONTROL_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const lockPath = path.join(dir, `${file}.lock`)
  let fd: number | null = null

  for (let attempt = 1; attempt <= LOCK_ACQUIRE_ATTEMPTS && fd === null; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
      // Held: break it only if its owner evidently died, else wait our turn.
      if (lockIsStale(lockPath)) {unlinkIfPossible(lockPath)} else {sleepSync(LOCK_RETRY_MS)}
    }
  }
  if (fd === null) {
    throw new Error(
      `control publication lock for ${file} is held by another publisher after ` +
        `${LOCK_ACQUIRE_ATTEMPTS} attempts — nothing was written`,
    )
  }

  try {
    try {
      fs.writeFileSync(fd, `${process.pid}\n`)
    } catch {
      // The lock's value is its existence, not its contents.
    }
    return fn()
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* already closed */
    }
    // If this was already removed (e.g. broken as stale by another publisher) the
    // staleness check is what keeps that from wedging publication.
    unlinkIfPossible(lockPath)
  }
}

/**
 * Atomic write of a control file (hub only).
 *
 * Pass `expected` to make this a compare-and-set: the write lands only if the target
 * still has the fingerprint the caller read it at (`null` = "must still be absent").
 * That is what stops two concurrent read-modify-write publishers from silently
 * dropping one another's revocation. Returns false when the CAS lost; the temp file
 * is always cleaned up, and the payload is fsynced before it is renamed into place so
 * a crash can never publish a truncated bundle — under a fail-closed reader that
 * would be a self-inflicted auth outage.
 */
export function writeRaw(file: string, value: unknown, expected?: FileFingerprint | null): boolean {
  const dir = CONTROL_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const full = path.join(dir, file)
  tmpCounter += 1
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`
  let tmpExists = false
  try {
    const fd = fs.openSync(tmp, 'wx')
    tmpExists = true
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (expected !== undefined && !matchesExpected(file, expected)) {return false}
    fs.renameSync(tmp, full)
    tmpExists = false
    fsyncDir(dir)
    invalidateReadCache(file)
    return true
  } finally {
    if (tmpExists) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // Best-effort cleanup; never mask the original publication error.
      }
    }
  }
}
