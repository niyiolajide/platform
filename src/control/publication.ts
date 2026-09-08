import fs from 'fs'
import { invalidateReadCache, probeFingerprint, type FileFingerprint } from './reader'
import { REVOCATIONS_SCHEMA, type Revocations } from './schema'
import { prunedRevocations, readPinnedRevocations, verifyPublishedRevocations } from './guarded'
import {
  commitStagedFile,
  controlLockHeld,
  discardStagedFile,
  linkStagedFile,
  matchesExpected,
  pinExistingFile,
  stageTempFile,
  unpinBackupLink,
  withControlLock,
} from './writer'

const PUBLISH_WRITE_ATTEMPTS = 4

/**
 * Replace the revocation list, pruning entries whose token has already expired.
 *
 * The INPUT is validated first, before pruning. Pruning rebuilds the bundle as
 * `{schemaVersion: 1, revoked: <filtered>}`, which would launder an unknown shape into
 * a valid-looking v1 bundle: a JS caller passing a v2 payload whose revocations live
 * under a different key would publish an EMPTY denylist that parses perfectly. Validate
 * what the caller actually handed us, not what we rebuilt from it.
 *
 * Replace-semantics, but never blind and never silently winning: the call pins the
 * live inode, re-checks fingerprint plus lock ownership immediately before the
 * rename, and verifies afterwards — and ANY observed concurrent interference throws
 * a loud conflict instead of reporting success. Retrying the same replace onto a
 * concurrent revoke would erase it while claiming operator intent, and union-
 * merging would corrupt replace intent (un-revoke by omission must keep working),
 * so the only honest recovery is the operator re-issuing the replace knowingly.
 * Transient torn reads retry boundedly; everything else throws on first contact.
 */
export function publishRevocations(r: Revocations): void {
  const validated = REVOCATIONS_SCHEMA.parse(r)
  const next = REVOCATIONS_SCHEMA.parse(prunedRevocations(validated))
  for (let attempt = 1; attempt <= PUBLISH_WRITE_ATTEMPTS; attempt += 1) {
    if (tryPublishRevocations(next)) {return}
  }
  throw new Error(
    `publishRevocations: revocations.json unreadable during verification on all ` +
      `${PUBLISH_WRITE_ATTEMPTS} attempts — no replacement was confirmed`,
  )
}

/**
 * One locked replace attempt. True when the replace verifiably stuck; false only
 * on transient torn reads (caller retries); throws on any observed concurrent
 * interference (caller must NOT retry blindly — see above).
 */
function tryPublishRevocations(next: Revocations): boolean {
  return withControlLock('revocations.json', () => {
    // Hardlink creation changes ctime. Capture the expected fingerprint AFTER
    // our link, then prove the path and pin still identify the same inode.
    const pin = pinExistingFile('revocations.json')
    try {
      return publishPinnedRevocations(next, pin)
    } finally {
      if (pin !== null) {unpinBackupLink(pin)}
    }
  })
}

function publishPinnedRevocations(next: Revocations, pin: string | null): boolean {
  const name = 'revocations.json'
  const probe = probeFingerprint(name)
  if (probe.kind === 'error') {
    throw new Error('publishRevocations: cannot probe revocations.json — refusing blind replace')
  }
  const expected = probe.kind === 'present' ? probe.fingerprint : null
  assertPinnedIdentity(pin, expected)
  const base = pin !== null ? readPinnedRevocations(pin) : null
  if (pin !== null && base === null) {return false}
  const staged = stageTempFile(name, next)
  try {
    if (!matchesExpected(name, expected)) {
      throw new Error(
        'publishRevocations: revocations.json moved before our rename — ' +
          'refusing to overwrite state this call never observed',
      )
    }
    if (!controlLockHeld(name)) {
      throw new Error(
        'publishRevocations: publication lock lost mid-operation — refusing to ' +
          'overwrite what the successor may have published',
      )
    }
    if (expected === null) {return linkBootstrapRevocations(name, staged.tmp, next)}
    commitStagedFile(name, staged.tmp)
    return verifyPublishedRevocations(staged.ino, next, pin, base)
  } finally {
    discardStagedFile(staged.tmp)
  }
}

/** A rename between pin and probe must not substitute an unobserved base. */
function assertPinnedIdentity(pin: string | null, expected: FileFingerprint | null): void {
  const pinned = pin === null ? null : fs.statSync(pin, { bigint: true })
  if (pinned === null && expected === null) {return}
  if (pinned !== null && expected !== null &&
      pinned.dev === expected.dev && pinned.ino === expected.ino) {return}
  throw new Error('publishRevocations: revocations.json moved while pinning — re-issue knowingly')
}

/** Bootstrap half of a replace attempt: atomic create, never a blind overwrite. */
function linkBootstrapRevocations(name: string, tmp: string, next: Revocations): boolean {
  try {
    linkStagedFile(name, tmp)
  } catch (error) {
    invalidateReadCache(name)
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      throw new Error(
        'publishRevocations: revocations.json created concurrently — ' +
          're-issue the replace knowingly instead of overwriting blind',
      )
    }
    throw error
  }
  return verifyPublishedRevocations(null, next, null, null)
}

