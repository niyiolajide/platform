"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchesExpected = matchesExpected;
exports.controlFilePath = controlFilePath;
exports.controlLockHeld = controlLockHeld;
exports.withControlLock = withControlLock;
exports.stageTempFile = stageTempFile;
exports.discardStagedFile = discardStagedFile;
exports.linkStagedFile = linkStagedFile;
exports.commitStagedFile = commitStagedFile;
exports.pinBackupLink = pinBackupLink;
exports.pinExistingFile = pinExistingFile;
exports.unpinBackupLink = unpinBackupLink;
exports.writeRaw = writeRaw;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const reader_1 = require("./reader");
// ── Control-bundle publication (hub only) ─────────────────────────────────────
// Only the hub mounts /control read-write. Writes here are temp + fsync + rename so
// readers never observe a partial bundle. (The ControlPlane web container cannot use
// this path — under its exact-file binds the root-owned /control rejects temp-file
// creation for UID 1001, so it publishes with its own in-place overwrite. That is
// precisely why the reader side validates snapshot stability; see reader.ts.)
const CONTROL_DIR = () => process.env.CONTROL_DIR ?? '/control';
let tmpCounter = 0;
/** Best-effort directory fsync so a completed rename survives a crash. */
function fsyncDir(dir) {
    let fd = null;
    try {
        fd = fs_1.default.openSync(dir, 'r');
        fs_1.default.fsyncSync(fd);
    }
    catch {
        // Unsupported on some platforms/mounts — durability of the rename itself is
        // still the filesystem's job; this is an extra guarantee, not a correctness one.
    }
    finally {
        if (fd !== null) {
            try {
                fs_1.default.closeSync(fd);
            }
            catch {
                /* already closed */
            }
        }
    }
}
function matchesExpected(file, expected) {
    const probe = (0, reader_1.probeFingerprint)(file);
    // Cannot tell what is there → refuse the write. Treating an EACCES/EIO stat as
    // "still absent" would let a bootstrap overwrite a bundle another publisher created.
    if (probe.kind === 'error') {
        return false;
    }
    if (expected === null) {
        return probe.kind === 'absent';
    }
    return probe.kind === 'present' && (0, reader_1.sameFingerprint)(probe.fingerprint, expected);
}
/** Absolute path of a control file in the currently configured control directory. */
function controlFilePath(file) {
    return path_1.default.join(CONTROL_DIR(), file);
}
// ── Publication mutual exclusion ──────────────────────────────────────────────
// A fingerprint compare-and-set narrows the read-modify-write race but cannot close
// it: POSIX `rename` is an unconditional atomic REPLACE, so between "the fingerprint
// still matches" and "rename" a competing publisher can still land and be overwritten.
// An O_EXCL lockfile is what actually serializes cooperating publishers, so the
// compare happens under exclusion. The CAS plus the guarded-write protocol below
// (backup-pin, content compare, post-rename verification) is what catches a writer
// that does NOT take the lock — notably ControlPlane's own in-place publisher.
const LOCK_ACQUIRE_ATTEMPTS = 50;
const LOCK_RETRY_MS = 10;
/** A lock older than this is assumed to belong to a crashed publisher. */
const LOCK_STALE_MS = 10000;
/** Best-effort unlink; losing the race to another cleaner is fine, we just retry. */
function unlinkIfPossible(target) {
    try {
        fs_1.default.unlinkSync(target);
    }
    catch {
        /* already gone */
    }
}
function lockIsStale(lockPath) {
    try {
        // Wall clock is unavoidable here (mtime IS wall clock). A backward clock jump only
        // makes a stale lock look fresh, which delays publication rather than corrupting
        // it — the fail-closed direction.
        return Date.now() - fs_1.default.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    }
    catch {
        return false; // vanished under us: not stale, just gone — retry the open
    }
}
/**
 * Locks this process currently holds, keyed by absolute lock path. Re-entry is by
 * depth, not by re-acquiring: these publishers are synchronous on a single thread,
 * so one process cannot race itself, and a nested acquire must not deadlock against
 * its own lockfile.
 */
const heldLocks = new Map();
let lockTokenCounter = 0;
function acquireLockFd(lockPath) {
    let fd = null;
    for (let attempt = 1; attempt <= LOCK_ACQUIRE_ATTEMPTS && fd === null; attempt += 1) {
        try {
            fd = fs_1.default.openSync(lockPath, 'wx');
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            // Held: break it only if its owner evidently died, else wait our turn. Breaking
            // is by design ownership-unsafe (that is what breaking means); safety comes from
            // re-acquiring via O_EXCL afterwards and from the original owner refusing to
            // unlink a lock it no longer owns on release (see below).
            if (lockIsStale(lockPath)) {
                unlinkIfPossible(lockPath);
            }
            else {
                (0, reader_1.sleepSync)(LOCK_RETRY_MS);
            }
        }
    }
    if (fd === null) {
        throw new Error(`control publication lock for ${lockPath} is held by another publisher after ` +
            `${LOCK_ACQUIRE_ATTEMPTS} attempts — nothing was written`);
    }
    // Ownership token: pid separates processes, the counter separates acquisitions in
    // this process (it still advances under a frozen test clock), and the timestamp
    // separates pid reuse across restarts.
    const token = `${process.pid}:${lockTokenCounter++}:${Date.now()}`;
    try {
        fs_1.default.writeFileSync(fd, `${token}\n`);
    }
    catch {
        // The lock's value is its existence, not its contents; an unwritable fd still
        // excludes. The token write is best-effort for the same reason.
    }
    return { token, fd };
}
function currentLockToken(lockPath) {
    try {
        return fs_1.default.readFileSync(lockPath, 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * True only while this process holds the publication lock for `file` AND the
 * lockfile still carries our ownership token. Publishers check this immediately
 * before their rename: a lock broken as stale mid-operation belongs to its
 * successor now, and proceeding to rename would clobber the successor's verified
 * write. Aborting instead (the caller retries under a fresh acquisition) is what
 * makes stale-takeover safe on the holder side.
 */
function controlLockHeld(file) {
    const lockPath = path_1.default.join(CONTROL_DIR(), `${file}.lock`);
    const held = heldLocks.get(lockPath);
    if (held == null) {
        return false;
    }
    return currentLockToken(lockPath) === `${held.token}\n`;
}
function releaseLockFd(lockPath, held) {
    try {
        fs_1.default.closeSync(held.fd);
    }
    catch {
        /* already closed */
    }
    // Ownership-safe release: unlink ONLY what we still own. If our lock was broken as
    // stale mid-operation and a successor has since taken it, its token is in the file
    // and unlinking would delete the SUCCESSOR's mutual exclusion — then the original
    // owner's post-release writes race the successor's. Leaving a stale-taken lock in
    // place is always safe: it either belongs to a live successor (correct) or to
    // nobody, in which case the next acquirer breaks it by staleness.
    if (currentLockToken(lockPath) === `${held.token}\n`) {
        unlinkIfPossible(lockPath);
    }
}
/**
 * Run `fn` holding an exclusive publication lock for `file` (hub only).
 *
 * Serializes publishers that go through this helper. ControlPlane's web container
 * publishes revocations with its own in-place overwrite (it cannot create files in the
 * root-owned /control under its exact-file binds), so it does NOT take this lock —
 * which is exactly why revocation publication additionally runs the guarded
 * compare-and-set protocol (backup-pin, content compare, post-rename verification)
 * that detects and recovers from a concurrent in-place landing.
 */
function withControlLock(file, fn) {
    const dir = CONTROL_DIR();
    fs_1.default.mkdirSync(dir, { recursive: true });
    const lockPath = path_1.default.join(dir, `${file}.lock`);
    const reentered = heldLocks.get(lockPath);
    if (reentered != null) {
        reentered.depth += 1;
        try {
            return fn();
        }
        finally {
            reentered.depth -= 1;
        }
    }
    const { token, fd } = acquireLockFd(lockPath);
    const held = { token, fd, depth: 1 };
    heldLocks.set(lockPath, held);
    try {
        return fn();
    }
    finally {
        heldLocks.delete(lockPath);
        releaseLockFd(lockPath, held);
    }
}
// ── Guarded compare-and-set primitives ────────────────────────────────────────
// `rename` replaces unconditionally, so a bare check-then-rename can never be safe
// against a publisher that lands in between — the check result is stale the moment
// it is read. The revocation publisher in revocations.ts closes that interval with
// these primitives plus the protocol in guarded.ts, executed under the publication
// lock with one history pin held for the whole call:
//
//  - hardlink-pin the live inode (an in-place competitor shares the pinned inode,
//    so its landing stays observable and mergeable even after our rename orphans
//    it — this is what covers the fingerprint-blind same-size-rewrite case, by
//    content rather than metadata),
//  - publish the UNION of live ∪ pin ∪ {our jti} every attempt, so no observed
//    revocation is ever left behind regardless of when anyone landed,
//  - fingerprint CAS as a cheap fast path plus a second fingerprint check and a
//    lock-ownership check immediately before the rename (a rename-based landing
//    inside the window, or a lock stolen mid-operation, aborts to a retry instead
//    of overwriting content never observed),
//  - subset verification after every rename: the live bundle must contain every
//    unexpired jti from our write AND from the pin, else re-read and re-merge.
//
// The remaining single-sided gaps are a landing in the final check→rename syscall
// gap and a writer holding a pre-rename fd whose write lands after the final
// verification read — both microsecond-scale, both converging via the caller's
// bounded retry (loud on exhaustion, never silent), and both fully closed once
// every rename-based publisher shares this lock (tracked follow-up for
// ControlPlane's writer).
/** Stage `value` as JSON in a unique temp file: returns its path and inode. */
function stageTempFile(file, value) {
    const dir = CONTROL_DIR();
    fs_1.default.mkdirSync(dir, { recursive: true });
    tmpCounter += 1;
    const tmp = `${path_1.default.join(dir, file)}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
    const fd = fs_1.default.openSync(tmp, 'wx');
    let staged = false;
    try {
        fs_1.default.writeFileSync(fd, JSON.stringify(value, null, 2));
        fs_1.default.fsyncSync(fd);
        const { ino } = fs_1.default.fstatSync(fd, { bigint: true });
        staged = true;
        return { tmp, ino };
    }
    finally {
        try {
            fs_1.default.closeSync(fd);
        }
        catch {
            /* close failure after a failed stage is not the publication result */
        }
        if (!staged) {
            discardStagedFile(tmp);
        }
    }
}
/** Best-effort removal of a staged temp file; never masks the publication result. */
function discardStagedFile(tmp) {
    try {
        fs_1.default.unlinkSync(tmp);
    }
    catch {
        /* already renamed away or never created */
    }
}
/**
 * Atomically publish a staged temp file by creating the target with it. Uses `link`
 * (which fails EEXIST when the target already exists) instead of `rename` (which
 * would silently replace a file a concurrent publisher just created). Durability of
 * the new directory entry is fsynced like the rename path.
 */
function linkStagedFile(file, tmp) {
    fs_1.default.linkSync(tmp, controlFilePath(file));
    fsyncDir(CONTROL_DIR());
}
/** Rename a staged temp file into place and fsync the directory entry. */
function commitStagedFile(file, tmp) {
    fs_1.default.renameSync(tmp, controlFilePath(file));
    fsyncDir(CONTROL_DIR());
}
/**
 * Hardlink-pin the live file to a unique backup name. The pin keeps the pre-write
 * inode observable (and its bytes recoverable) even after our rename orphans it —
 * which is what makes a concurrent in-place landing detectable AND recoverable.
 * Throws ENOENT when the live file is absent.
 */
function pinBackupLink(file) {
    tmpCounter += 1;
    const backup = `${controlFilePath(file)}.casbackup-${process.pid}-${Date.now()}-${tmpCounter}`;
    fs_1.default.linkSync(controlFilePath(file), backup);
    return backup;
}
/** Pin an existing file; absence alone is eligible for atomic bootstrap. */
function pinExistingFile(file) {
    try {
        return pinBackupLink(file);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
/** Best-effort removal of a backup pin; never masks the publication result. */
function unpinBackupLink(backup) {
    try {
        fs_1.default.unlinkSync(backup);
    }
    catch {
        /* already gone */
    }
}
/**
 * Atomic write of a control file (hub only).
 *
 * Pass `expected` to make this a compare-and-set: the write lands only if the target
 * still has the fingerprint the caller read it at (`null` = "must still be absent").
 * A bare check-then-rename narrows but cannot close the race against a publisher
 * that lands in between (`rename` replaces unconditionally), so the
 * security-critical revocation publisher uses the guarded protocol in guarded.ts
 * (backup-pin, content compare, post-rename verification) instead of this flag.
 * Returns false when the CAS lost; the temp file is always cleaned up, and the
 * payload is fsynced before it is renamed into place so a crash can never publish
 * a truncated bundle — under a fail-closed reader that would be a self-inflicted
 * auth outage.
 */
function writeRaw(file, value, expected) {
    const dir = CONTROL_DIR();
    fs_1.default.mkdirSync(dir, { recursive: true });
    const full = path_1.default.join(dir, file);
    tmpCounter += 1;
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
    let tmpExists = false;
    try {
        const fd = fs_1.default.openSync(tmp, 'wx');
        tmpExists = true;
        try {
            fs_1.default.writeFileSync(fd, JSON.stringify(value, null, 2));
            fs_1.default.fsyncSync(fd);
        }
        finally {
            fs_1.default.closeSync(fd);
        }
        if (expected !== undefined && !matchesExpected(file, expected)) {
            return false;
        }
        fs_1.default.renameSync(tmp, full);
        tmpExists = false;
        fsyncDir(dir);
        (0, reader_1.invalidateReadCache)(file);
        return true;
    }
    finally {
        if (tmpExists) {
            try {
                fs_1.default.unlinkSync(tmp);
            }
            catch {
                // Best-effort cleanup; never mask the original publication error.
            }
        }
    }
}
