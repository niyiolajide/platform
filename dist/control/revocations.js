"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RevocationsUnavailableError = exports.publishRevocations = void 0;
exports.readRevocations = readRevocations;
exports.checkJtiRevocation = checkJtiRevocation;
exports.isRevoked = isRevoked;
exports.revokeJti = revokeJti;
const config_1 = require("../config");
const reader_1 = require("./reader");
const schema_1 = require("./schema");
const guarded_1 = require("./guarded");
const writer_1 = require("./writer");
var publication_1 = require("./publication");
Object.defineProperty(exports, "publishRevocations", { enumerable: true, get: function () { return publication_1.publishRevocations; } });
// ── Offline revocation denylist ───────────────────────────────────────────────
// Security-critical, and the one control bundle that must never fail open. An
// unreadable, torn, or shape-unknown denylist is NOT an empty denylist: it is
// "unavailable", and token verification denies.
const REVOCATION_READ_ATTEMPTS = 3;
// Small, bounded backoff. The failure this covers is a torn in-place rewrite, whose
// window is the duration of one write — microseconds to low milliseconds. Retrying
// with no delay at all can burn all three attempts inside a single such window.
const REVOCATION_READ_BACKOFF_MS = [5, 25];
/**
 * Hard ceiling on the last-known-good grace window. Fail-closed with ZERO outage
 * tolerance turns any /control disruption into a 100% platform-wide auth lockout, so
 * a snapshot this process already read and validated may be replayed for a bounded
 * time while the bundle is unreadable. It is a security-posture parameter
 * (`CONTROL_REVOCATIONS_GRACE_MS`, opt-in and clamped to this ceiling): a longer window means
 * revocation takes longer to bite during an outage; 0 disables the grace entirely and
 * an outage denies immediately. It can never manufacture a snapshot — an absent or
 * never-valid bundle still denies from the very first request.
 */
const REVOCATION_GRACE_MAX_MS = 60000;
const REVOKE_WRITE_ATTEMPTS = 4;
class RevocationsUnavailableError extends Error {
    constructor(failure) {
        super(`revocations.json is absent, unstable, unreadable, or invalid (${failure})`);
        this.name = 'RevocationsUnavailableError';
        this.failure = failure;
    }
}
exports.RevocationsUnavailableError = RevocationsUnavailableError;
let warnedBadGraceValue = false;
function revocationGraceMs() {
    const raw = process.env.CONTROL_REVOCATIONS_GRACE_MS;
    if (raw == null || raw.trim() === '') {
        return 0;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        // Invalid configuration must not silently opt into stale authentication.
        if (!warnedBadGraceValue) {
            warnedBadGraceValue = true;
            (0, config_1.getLogger)().warn({ defaultMs: 0 }, '[control] CONTROL_REVOCATIONS_GRACE_MS is not a non-negative number — ignoring it ' +
                'and using the default zero-grace policy.');
        }
        return 0;
    }
    return Math.min(parsed, REVOCATION_GRACE_MAX_MS);
}
// After bounded retries and an expired grace window, an absent, unstable, unreadable,
// or schema-invalid bundle denies token verification and blocks read-modify-write
// publication. Warn loudly, throttled to protect the hot path, and always name the
// failure class so the root cause is not discarded.
let lastRevocationsWarnMs = 0;
function warnRevocationsUnavailable(failure) {
    const now = Date.now();
    if (now - lastRevocationsWarnMs < 60000) {
        return;
    }
    lastRevocationsWarnMs = now;
    (0, config_1.getLogger)().warn({ file: 'revocations.json', failure }, '[control] revocations file unavailable after bounded retries — FAILING CLOSED. ' +
        'Check the control bundle is published and mounted.');
}
// Deliberately a DIFFERENT alarm from the fail-closed warning above: this one means
// authentication is still succeeding but on evidence that is no longer being
// refreshed, which is the window an operator has to fix the mount before every
// session is denied.
let lastRevocationsStaleAlarmMs = 0;
function alarmServingStaleRevocations(ageMs, graceMs) {
    const now = Date.now();
    if (now - lastRevocationsStaleAlarmMs < 5000) {
        return;
    }
    lastRevocationsStaleAlarmMs = now;
    (0, config_1.getLogger)().warn({ file: 'revocations.json', ageMs, graceMs }, '[control] SERVING A STALE revocations snapshot inside the last-known-good grace ' +
        'window — a token revoked during this outage may still be accepted, and token ' +
        'verification HARD-DENIES once the window expires. Restore the control bundle now.');
}
function readRevocationsSnapshot(graceMs) {
    return (0, reader_1.readStable)('revocations.json', {
        attempts: REVOCATION_READ_ATTEMPTS,
        backoffMs: REVOCATION_READ_BACKOFF_MS,
        graceMs,
        logFailure: false,
        validate: (raw) => schema_1.REVOCATIONS_SCHEMA.parse(raw),
    });
}
/**
 * The current revocation denylist.
 *
 * THROWS `RevocationsUnavailableError` when no valid snapshot can be obtained — an
 * unreadable denylist is never reported as an empty one. Within the grace window a
 * previously validated snapshot is returned and alarmed instead. Callers doing
 * read-modify-write must not use this; see `revokeJti`.
 */
function readRevocations() {
    const graceMs = revocationGraceMs();
    const result = readRevocationsSnapshot(graceMs);
    if (!result.ok) {
        warnRevocationsUnavailable(result.failure);
        throw new RevocationsUnavailableError(result.failure);
    }
    if (result.stale) {
        alarmServingStaleRevocations(result.ageMs, graceMs);
    }
    return result.value;
}
function readRevocationsForWrite() {
    // No grace on the write path: republishing a stale snapshot would drop any
    // revocation that landed while the bundle was unreadable.
    const result = readRevocationsSnapshot(0);
    if (result.ok && !result.stale) {
        return { current: result.value, expected: result.fingerprint };
    }
    if (!result.ok && result.failure === 'absent') {
        // Bootstrap, and ONLY for an absent file. A fresh volume or first-ever deploy
        // must not be a total auth outage that the normal API cannot repair — with no
        // file there is nothing to lose by starting from an empty denylist. A parse,
        // schema, permission, or IO failure is the opposite case: real content exists
        // that we cannot read, and overwriting it would silently drop live revocations.
        return { current: { schemaVersion: 1, revoked: [] }, expected: null };
    }
    const failure = result.ok ? 'unstable' : result.failure;
    warnRevocationsUnavailable(failure);
    throw new RevocationsUnavailableError(failure);
}
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
function checkJtiRevocation(jti) {
    let revocations;
    try {
        revocations = readRevocations();
    }
    catch {
        return 'unavailable';
    }
    // Re-widened on purpose: this value comes straight off an untrusted JWT payload,
    // so the declared type is a claim about the caller, not about the runtime value.
    const claim = jti;
    if (claim == null) {
        return 'clear';
    }
    if (typeof claim !== 'string' || claim.trim() === '') {
        return 'revoked';
    }
    return revocations.revoked.some((r) => r.jti === claim) ? 'revoked' : 'clear';
}
function isRevoked(jti) {
    return checkJtiRevocation(jti) !== 'clear';
}
/** One locked read-merge-publish attempt. True when the revocation is live. */
function tryRevokeJtiAttempt(jti, exp, state) {
    return (0, writer_1.withControlLock)('revocations.json', () => {
        const { current, expected } = readRevocationsForWrite();
        if (expected !== null && state.pin === null) {
            state.pin = (0, writer_1.pinExistingFile)('revocations.json');
            if (state.pin === null) {
                return false;
            }
        }
        const lists = [current];
        if (state.pin !== null) {
            const pinned = (0, guarded_1.readPinnedRevocations)(state.pin);
            // Torn pin read (a competitor mid-write): retry, it may settle.
            if (pinned === null) {
                return false;
            }
            lists.push(pinned);
        }
        const next = (0, guarded_1.mergeRevocations)([...lists, { schemaVersion: 1, revoked: [{ jti, exp }] }]);
        // Nothing new to publish: the live file already holds this exact set, so the
        // pin (when held) adds nothing unmerged and returning now orphans nothing.
        // This keeps idempotent re-revocation a pure read with zero filesystem writes.
        if ((0, guarded_1.sameRevocationContent)(next, current)) {
            return true;
        }
        return (0, guarded_1.guardedPublishRevocations)(next, expected, state.pin);
    });
}
/**
 * Add a single jti to the revocation list (hub only).
 *
 * Read-modify-write where every attempt runs under an exclusive publication lock
 * plus the guarded protocol in guarded.ts. The lock serializes cooperating
 * publishers; the single history pin (held across attempts, unlinked at the end)
 * plus union-merge plus subset verification is what stops a lost update against a
 * publisher that never took the lock — notably ControlPlane's own in-place writer,
 * which cannot temp+rename under its exact-file binds. Anything the pin or the
 * live file observes is merged, never overwritten — and a verification mismatch
 * retries under a fresh acquisition rather than reporting a success that erased
 * someone else's revocation.
 */
function revokeJti(jti, exp) {
    // One history pin for the whole call: it keeps the pre-call inode observable
    // across attempts, so an in-place landing orphaned by one attempt's rename is
    // still mergeable by the next. Unlinked only at the end — on success its bytes
    // are proven live, on exhaustion the throw below is loud, never silent.
    const state = { pin: null };
    try {
        for (let attempt = 1; attempt <= REVOKE_WRITE_ATTEMPTS; attempt += 1) {
            if (tryRevokeJtiAttempt(jti, exp, state)) {
                return;
            }
        }
        throw new Error(`revokeJti: revocations.json changed under concurrent publication on all ` +
            `${REVOKE_WRITE_ATTEMPTS} attempts — the revocation was NOT published`);
    }
    finally {
        if (state.pin !== null) {
            (0, writer_1.unpinBackupLink)(state.pin);
        }
    }
}
