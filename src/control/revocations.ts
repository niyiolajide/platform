import { getLogger } from '../config'
import { readStable, type FileFingerprint, type ReadFailureClass, type StableRead } from './reader'
import { REVOCATIONS_SCHEMA, type Revocations } from './schema'
import { withControlLock, writeRaw } from './writer'

// ── Offline revocation denylist ───────────────────────────────────────────────
// Security-critical, and the one control bundle that must never fail open. An
// unreadable, torn, or shape-unknown denylist is NOT an empty denylist: it is
// "unavailable", and token verification denies.

const REVOCATION_READ_ATTEMPTS = 3
// Small, bounded backoff. The failure this covers is a torn in-place rewrite, whose
// window is the duration of one write — microseconds to low milliseconds. Retrying
// with no delay at all can burn all three attempts inside a single such window.
const REVOCATION_READ_BACKOFF_MS = [5, 25] as const
/**
 * Hard ceiling on the last-known-good grace window. Fail-closed with ZERO outage
 * tolerance turns any /control disruption into a 100% platform-wide auth lockout, so
 * a snapshot this process already read and validated may be replayed for a bounded
 * time while the bundle is unreadable. It is a security-posture parameter
 * (`CONTROL_REVOCATIONS_GRACE_MS`, clamped to this ceiling): a longer window means
 * revocation takes longer to bite during an outage; 0 disables the grace entirely and
 * an outage denies immediately. It can never manufacture a snapshot — an absent or
 * never-valid bundle still denies from the very first request.
 */
const REVOCATION_GRACE_MAX_MS = 60_000
const REVOKE_WRITE_ATTEMPTS = 4

export class RevocationsUnavailableError extends Error {
  /** Why the read failed — an operator needs `absent` vs `permission` vs `parse`. */
  readonly failure: ReadFailureClass
  constructor(failure: ReadFailureClass) {
    super(`revocations.json is absent, unstable, unreadable, or invalid (${failure})`)
    this.name = 'RevocationsUnavailableError'
    this.failure = failure
  }
}

let warnedBadGraceValue = false

function revocationGraceMs(): number {
  const raw = process.env.CONTROL_REVOCATIONS_GRACE_MS
  if (raw == null || raw.trim() === '') {return REVOCATION_GRACE_MAX_MS}
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Falling back to the default here means an unusable value selects the WIDEST
    // permitted window, so say so out loud once: a typo in a security-posture knob
    // must not look like a deliberate setting.
    if (!warnedBadGraceValue) {
      warnedBadGraceValue = true
      getLogger().warn(
        { value: raw, defaultMs: REVOCATION_GRACE_MAX_MS },
        '[control] CONTROL_REVOCATIONS_GRACE_MS is not a non-negative number — ignoring it ' +
          'and using the default (maximum) last-known-good grace window. Set 0 to disable grace.',
      )
    }
    return REVOCATION_GRACE_MAX_MS
  }
  return Math.min(parsed, REVOCATION_GRACE_MAX_MS)
}

// After bounded retries and an expired grace window, an absent, unstable, unreadable,
// or schema-invalid bundle denies token verification and blocks read-modify-write
// publication. Warn loudly, throttled to protect the hot path, and always name the
// failure class so the root cause is not discarded.
let lastRevocationsWarnMs = 0
function warnRevocationsUnavailable(failure: ReadFailureClass): void {
  const now = Date.now()
  if (now - lastRevocationsWarnMs < 60_000) {return}
  lastRevocationsWarnMs = now
  getLogger().warn(
    { file: 'revocations.json', failure },
    '[control] revocations file unavailable after bounded retries — FAILING CLOSED. ' +
      'Check the control bundle is published and mounted.',
  )
}

// Deliberately a DIFFERENT alarm from the fail-closed warning above: this one means
// authentication is still succeeding but on evidence that is no longer being
// refreshed, which is the window an operator has to fix the mount before every
// session is denied.
let lastRevocationsStaleAlarmMs = 0
function alarmServingStaleRevocations(ageMs: number, graceMs: number): void {
  const now = Date.now()
  if (now - lastRevocationsStaleAlarmMs < 5_000) {return}
  lastRevocationsStaleAlarmMs = now
  getLogger().warn(
    { file: 'revocations.json', ageMs, graceMs },
    '[control] SERVING A STALE revocations snapshot inside the last-known-good grace ' +
      'window — a token revoked during this outage may still be accepted, and token ' +
      'verification HARD-DENIES once the window expires. Restore the control bundle now.',
  )
}

function readRevocationsSnapshot(graceMs: number): StableRead<Revocations> {
  return readStable<Revocations>('revocations.json', {
    attempts: REVOCATION_READ_ATTEMPTS,
    backoffMs: REVOCATION_READ_BACKOFF_MS,
    graceMs,
    logFailure: false,
    validate: (raw) => REVOCATIONS_SCHEMA.parse(raw),
  })
}

/**
 * The current revocation denylist.
 *
 * THROWS `RevocationsUnavailableError` when no valid snapshot can be obtained — an
 * unreadable denylist is never reported as an empty one. Within the grace window a
 * previously validated snapshot is returned and alarmed instead. Callers doing
 * read-modify-write must not use this; see `revokeJti`.
 */
export function readRevocations(): Revocations {
  const graceMs = revocationGraceMs()
  const result = readRevocationsSnapshot(graceMs)
  if (!result.ok) {
    warnRevocationsUnavailable(result.failure)
    throw new RevocationsUnavailableError(result.failure)
  }
  if (result.stale) {alarmServingStaleRevocations(result.ageMs, graceMs)}
  return result.value
}

interface RevocationsForWrite {
  current: Revocations
  /** Fingerprint to compare-and-set against; null means "was absent, must still be". */
  expected: FileFingerprint | null
}

function readRevocationsForWrite(): RevocationsForWrite {
  // No grace on the write path: republishing a stale snapshot would drop any
  // revocation that landed while the bundle was unreadable.
  const result = readRevocationsSnapshot(0)
  if (result.ok && !result.stale) {return { current: result.value, expected: result.fingerprint }}
  if (!result.ok && result.failure === 'absent') {
    // Bootstrap, and ONLY for an absent file. A fresh volume or first-ever deploy
    // must not be a total auth outage that the normal API cannot repair — with no
    // file there is nothing to lose by starting from an empty denylist. A parse,
    // schema, permission, or IO failure is the opposite case: real content exists
    // that we cannot read, and overwriting it would silently drop live revocations.
    return { current: { schemaVersion: 1, revoked: [] }, expected: null }
  }
  const failure: ReadFailureClass = result.ok ? 'unstable' : result.failure
  warnRevocationsUnavailable(failure)
  throw new RevocationsUnavailableError(failure)
}

export type JtiRevocationStatus = 'clear' | 'revoked' | 'unavailable'

/**
 * Preserve the distinction between a known revocation and unavailable revocation
 * state. Authentication callers must accept only `clear`.
 *
 * A token with NO `jti` is `clear` when the denylist is readable, and is therefore NOT
 * individually revocable — it is bounded only by its own `exp` and by key rotation.
 * Be precise about what enforces that boundary: NOTHING HERE DOES. This function sees
 * only a `jti` argument, so it cannot tell a short-lived job/service token (which
 * ControlPlane deliberately mints without a `jti`) from an interactive session (which
 * ControlPlane mints with a UUID `jti`, rejecting a missing or blank one). The
 * exemption is only as narrow as the MINTER keeps it; a signed no-`jti` session token
 * would be accepted here and could never be denylisted. Requiring `jti` universally
 * would break the current job/service-token contract, so that tightening belongs in a
 * coordinated change across ControlPlane and this library.
 *
 * A PRESENT but blank/non-string `jti` is denied outright — it is not a shape any
 * minter produces, and honouring it would create a permanently unrevocable token.
 */
export function checkJtiRevocation(jti: string | undefined | null): JtiRevocationStatus {
  let revocations: Revocations
  try {
    revocations = readRevocations()
  } catch {
    return 'unavailable'
  }
  // Re-widened on purpose: this value comes straight off an untrusted JWT payload,
  // so the declared type is a claim about the caller, not about the runtime value.
  const claim: unknown = jti
  if (claim == null) {return 'clear'}
  if (typeof claim !== 'string' || claim.trim() === '') {return 'revoked'}
  return revocations.revoked.some((r) => r.jti === claim) ? 'revoked' : 'clear'
}

export function isRevoked(jti: string | undefined | null): boolean {
  return checkJtiRevocation(jti) !== 'clear'
}

function prunedRevocations(r: Revocations): Revocations {
  const now = Math.floor(Date.now() / 1000)
  return { schemaVersion: 1, revoked: r.revoked.filter((e) => e.exp > now) }
}

/**
 * Replace the revocation list, pruning entries whose token has already expired.
 *
 * The INPUT is validated first, before pruning. Pruning rebuilds the bundle as
 * `{schemaVersion: 1, revoked: <filtered>}`, which would launder an unknown shape into
 * a valid-looking v1 bundle: a JS caller passing a v2 payload whose revocations live
 * under a different key would publish an EMPTY denylist that parses perfectly. Validate
 * what the caller actually handed us, not what we rebuilt from it.
 */
export function publishRevocations(r: Revocations): void {
  const validated = REVOCATIONS_SCHEMA.parse(r)
  writeRaw('revocations.json', REVOCATIONS_SCHEMA.parse(prunedRevocations(validated)))
}

/**
 * Add a single jti to the revocation list (hub only).
 *
 * Read-modify-write, so the whole read/merge/write runs under an exclusive publication
 * lock AND compare-and-sets against the snapshot it read. The lock is what actually
 * prevents a lost update (a bare CAS still has a check→rename window, because `rename`
 * replaces unconditionally); the CAS additionally catches a publisher that never took
 * the lock — notably ControlPlane's own in-place writer. If the snapshot moved anyway,
 * the write is refused and the merge retried rather than silently overwriting — and
 * permanently losing — someone else's revocation.
 */
export function revokeJti(jti: string, exp: number): void {
  withControlLock('revocations.json', () => {
    for (let attempt = 1; attempt <= REVOKE_WRITE_ATTEMPTS; attempt += 1) {
      const { current, expected } = readRevocationsForWrite()
      if (current.revoked.some((e) => e.jti === jti)) {return}
      const next = REVOCATIONS_SCHEMA.parse(
        prunedRevocations({ schemaVersion: 1, revoked: [...current.revoked, { jti, exp }] }),
      )
      if (writeRaw('revocations.json', next, expected)) {return}
    }
    throw new Error(
      `revokeJti: revocations.json changed under concurrent publication on all ` +
        `${REVOKE_WRITE_ATTEMPTS} attempts — the revocation was NOT published`,
    )
  })
}
