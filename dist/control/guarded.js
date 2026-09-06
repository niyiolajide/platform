"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prunedRevocations = prunedRevocations;
exports.mergeRevocations = mergeRevocations;
exports.readPinnedRevocations = readPinnedRevocations;
exports.sameRevocationContent = sameRevocationContent;
exports.guardedPublishRevocations = guardedPublishRevocations;
exports.verifyPublishedRevocations = verifyPublishedRevocations;
const fs_1 = __importDefault(require("fs"));
const reader_1 = require("./reader");
const schema_1 = require("./schema");
const writer_1 = require("./writer");
// ── Guarded revocation publication ────────────────────────────────────────────
// `rename` replaces unconditionally, so a bare check-then-rename can never be safe
// against a publisher that lands in between. This protocol closes that interval for
// `revokeJti` (each attempt runs under the publication lock) with three parts:
//
//  - ONE history pin per call: the caller hardlink-pins the live inode before its
//    first guarded attempt and keeps the pin until the call ends. An in-place
//    competitor shares the pinned inode, so its bytes stay observable (and
//    mergeable) through the pin even after our rename orphans them. The pin is
//    unlinked only at the end — on success its bytes are proven live, on
//    exhaustion the caller's throw is loud, never silent.
//  - union merge: every attempt publishes live ∪ pin ∪ {our jti}, so no observed
//    revocation is ever left behind, whichever publisher landed when.
//  - subset verification after every rename: the live bundle must contain every
//    unexpired jti from our write AND from the pin. Anything landing between our
//    last check and the verification reads is observed here and merged on retry.
//
// The contract is deliberately one-sided and honest: no SUCCESS is ever reported
// while data observable at-or-before the last verification read is missing from
// the live bundle. What remains is irreducible single-sided: a landing after the
// final verification read (microsecond window, converges on the next call) and a
// writer holding a pre-rename fd whose write lands after it. Both are bounded by
// the caller's retry budget, which fails LOUD on exhaustion — never silent loss.
// Full closure for rename-based writers needs every publisher to share the lock
// (tracked follow-up for ControlPlane's writer).
const NAME = 'revocations.json';
function prunedRevocations(r) {
    const now = Math.floor(Date.now() / 1000);
    return { schemaVersion: 1, revoked: r.revoked.filter((e) => e.exp > now) };
}
/**
 * Canonical bytes for a denylist: order-insensitive, so content equality is a
 * pure set comparison. Fingerprints are blind to same-size rewrites on
 * coarse-mtime filesystems; bytes are not.
 */
function canonicalRevocations(r) {
    const sorted = [...r.revoked].sort((a, b) => a.jti < b.jti ? -1 : a.jti > b.jti ? 1 : a.exp - b.exp);
    return JSON.stringify({ schemaVersion: 1, revoked: sorted });
}
/** Unexpired jtis: expiry is the only legitimate reason for live to lack a jti. */
function unexpiredJtis(r) {
    const now = Math.floor(Date.now() / 1000);
    return new Set(r.revoked.filter((e) => e.exp > now).map((e) => e.jti));
}
/**
 * Union of denylist snapshots, deduplicated by jti (first occurrence wins, so live
 * state beats orphaned history), pruned and validated. The new jti is appended by
 * the caller before invoking this.
 */
function mergeRevocations(lists) {
    const seen = new Set();
    const revoked = [];
    for (const list of lists) {
        for (const entry of list.revoked) {
            if (!seen.has(entry.jti)) {
                seen.add(entry.jti);
                revoked.push(entry);
            }
        }
    }
    return schema_1.REVOCATIONS_SCHEMA.parse(prunedRevocations({ schemaVersion: 1, revoked }));
}
/** Current bytes behind a history pin, or null when torn/unreadable (retry later). */
function readPinnedRevocations(pin) {
    try {
        return schema_1.REVOCATIONS_SCHEMA.parse(JSON.parse(fs_1.default.readFileSync(pin, 'utf8')));
    }
    catch {
        return null;
    }
}
/**
 * True when two denylists hold the same jti set (order-insensitive, pruned). The
 * caller merges live ∪ pin ∪ {new} and compares against live: equality proves the
 * pin and the new jti added nothing the live file lacked, so returning early can
 * never orphan unmerged history. Inequality only costs a converging rewrite.
 */
function sameRevocationContent(a, b) {
    return canonicalRevocations(a) === canonicalRevocations(b);
}
/** Current live bytes, or null when torn/unreadable (retry later). */
function readLiveRevocations() {
    try {
        return schema_1.REVOCATIONS_SCHEMA.parse(JSON.parse(fs_1.default.readFileSync((0, writer_1.controlFilePath)(NAME), 'utf8')));
    }
    catch {
        return null;
    }
}
function liveRevocationsIno() {
    const probe = (0, reader_1.probeFingerprint)(NAME);
    return probe.kind === 'present' ? probe.fingerprint.ino : null;
}
/** A publication supersedes every pre-write snapshot: drop the read caches. */
function invalidateRevocationCaches() {
    (0, reader_1.invalidateReadCache)(NAME);
}
/**
 * Guarded publish of an already-merged denylist. Returns true only when the live
 * bundle verifiably contains every unexpired jti from `next` AND from the history
 * pin; false means re-read and re-merge (bounded attempts by the caller). The pin
 * may be null on the bootstrap path, where there is no history to protect.
 */
function guardedPublishRevocations(next, expected, pin) {
    if (expected === null) {
        return publishBootstrapRevocations(next, pin);
    }
    // Cheap fast path: the fingerprint we merged from must still be live. Skips the
    // staging syscalls when a rename-based publisher already moved the file.
    if (!(0, writer_1.matchesExpected)(NAME, expected)) {
        return false;
    }
    const staged = (0, writer_1.stageTempFile)(NAME, next);
    try {
        // Second check immediately before the rename: a rename-based landing inside the
        // stage window invalidates the union basis, so re-read instead of overwriting
        // content we have never observed. The ownership check is the other half: a lock
        // broken as stale mid-operation belongs to its successor now — renaming anyway
        // would clobber the successor's verified write, so abort to a fresh acquisition.
        if (!(0, writer_1.matchesExpected)(NAME, expected)) {
            return false;
        }
        if (!(0, writer_1.controlLockHeld)(NAME)) {
            return false;
        }
        (0, writer_1.commitStagedFile)(NAME, staged.tmp);
        return verifyGuardedPublish(staged.ino, pin, next);
    }
    finally {
        (0, writer_1.discardStagedFile)(staged.tmp);
    }
}
/**
 * Bootstrap, and ONLY for a file that is still absent: create atomically with
 * `link` (EEXIST when a concurrent publisher just created it) instead of `rename`
 * (which would silently replace what they just created).
 */
function publishBootstrapRevocations(next, pin) {
    const staged = (0, writer_1.stageTempFile)(NAME, next);
    try {
        try {
            (0, writer_1.linkStagedFile)(NAME, staged.tmp);
        }
        catch (error) {
            if (error?.code === 'EEXIST') {
                // Proof the file now exists: our absent-read (and its 250ms remembered
                // failure) is stale evidence. Drop it so the retry re-reads instead of
                // bootstrapping blind into another EEXIST until the window expires.
                invalidateRevocationCaches();
                return false;
            }
            throw error;
        }
        return verifyGuardedPublish(null, pin, next);
    }
    finally {
        (0, writer_1.discardStagedFile)(staged.tmp);
    }
}
/**
 * Post-write verification. `tmpIno` is null on the bootstrap path (there is no
 * inode to compare — creation itself is the atomicity). Every unexpired jti the
 * caller merged (its write) and every unexpired jti in the history pin must be
 * present in the live bundle; anything else means a concurrent landing that the
 * next attempt must merge.
 */
function verifyGuardedPublish(tmpIno, pin, next) {
    if (tmpIno !== null && liveRevocationsIno() !== tmpIno) {
        return false;
    }
    const live = readLiveRevocations();
    if (live === null) {
        return false;
    }
    const liveJtis = unexpiredJtis(live);
    for (const jti of unexpiredJtis(next)) {
        if (!liveJtis.has(jti)) {
            return false;
        }
    }
    if (pin !== null) {
        const pinned = readPinnedRevocations(pin);
        if (pinned === null) {
            return false;
        }
        for (const jti of unexpiredJtis(pinned)) {
            if (!liveJtis.has(jti)) {
                return false;
            }
        }
    }
    invalidateRevocationCaches();
    return true;
}
/**
 * Post-write verification for the REPLACE path (`publishRevocations`). Same
 * observations as the merge path, opposite recovery: a replace must never
 * silently win over concurrent state, and re-merging would corrupt replace
 * intent (un-revoke by omission must keep working) — so any interference throws
 * a loud conflict for the operator to re-issue knowingly, instead of returning a
 * success that erased someone else's revocation. Unreadable verification reads
 * (a competitor mid-write tear) return false so the caller retries; everything
 * else that fails here is proof of concurrent activity, not outage.
 *
 * Pin check with a base discriminator (unlike the merge path's plain subset
 * check): the pin shares the live inode, so an in-place landing AFTER our
 * observation is visible on the pin at verify time. Anything on the pin that
 * was NOT in `base` arrived after we looked — if our rename orphaned it
 * (missing from live), throwing is the only honest recovery. Deliberate
 * omission only ever removes base content, so it never trips this check.
 * `base` is null only on the bootstrap path, where no prior content exists.
 */
function verifyPublishedRevocations(tmpIno, next, pin, base) {
    if (tmpIno !== null && liveRevocationsIno() !== tmpIno) {
        throw new Error('publishRevocations: revocations.json was replaced after our rename — ' +
            'refusing to report a replace that did not stick');
    }
    const live = readLiveRevocations();
    if (live === null) {
        return false;
    }
    if (!sameRevocationContent(live, next)) {
        throw new Error('publishRevocations: revocations.json content moved under our replace — ' +
            'refusing to report success over state this call never observed');
    }
    if (pin !== null) {
        const pinned = readPinnedRevocations(pin);
        if (pinned === null) {
            return false;
        }
        const baseJtis = base !== null ? unexpiredJtis(base) : new Set();
        const liveJtis = unexpiredJtis(live);
        for (const jti of unexpiredJtis(pinned)) {
            if (!baseJtis.has(jti) && !liveJtis.has(jti)) {
                throw new Error('publishRevocations: a concurrent revocation landed inside our replace ' +
                    'window — refusing to silently erase it; re-issue the replace knowingly');
            }
        }
    }
    invalidateRevocationCaches();
    return true;
}
