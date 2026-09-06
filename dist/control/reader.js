"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sameFingerprint = sameFingerprint;
exports.probeFingerprint = probeFingerprint;
exports.sleepSync = sleepSync;
exports.readStable = readStable;
exports.readRaw = readRaw;
exports.invalidateReadCache = invalidateReadCache;
exports.clearReadCache = clearReadCache;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
/**
 * Elapsed-time source for every deadline here. MONOTONIC on purpose: a backward
 * wall-clock jump (NTP, an operator fixing a drifted host) must not be able to extend
 * the grace window or the cache bound — both are security deadlines.
 */
const elapsedMs = () => performance.now();
/**
 * Bound how long an unchanged-looking file may be served from cache. The fingerprint is
 * exact at nanosecond resolution, but a same-size in-place rewrite within one timestamp
 * tick is invisible on a coarse-mtime filesystem. Re-reading at most once a second caps
 * that staleness at ~1s for one extra readFileSync per second per file.
 */
const CACHE_TTL_MS = 1000;
/**
 * How long a TERMINAL read failure is remembered. Without it, a persistently unreadable
 * bundle re-pays the whole retry budget — including its synchronous backoff — on every
 * verification, stalling the event loop precisely during an incident. Kept to a fraction
 * of a second so recovery is still noticed promptly; a remembered failure only ever
 * routes to the grace/deny path, never to a fresh accept.
 */
const FAILURE_TTL_MS = 250;
class UnstableSnapshotError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnstableSnapshotError';
    }
}
const cache = new Map();
const lastGood = new Map();
const failures = new Map();
const controlDir = () => process.env.CONTROL_DIR ?? '/control';
function fingerprint(s) {
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
}
function sameFingerprint(a, b) {
    return (a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs);
}
function probeFingerprint(file) {
    try {
        return {
            kind: 'present',
            fingerprint: fingerprint(fs_1.default.statSync(path_1.default.join(controlDir(), file), { bigint: true })),
        };
    }
    catch (error) {
        const code = error?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return { kind: 'absent' };
        }
        return { kind: 'error', error };
    }
}
function classify(error) {
    if (error instanceof UnstableSnapshotError) {
        return 'unstable';
    }
    if (error instanceof SyntaxError) {
        return 'parse';
    }
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
        return 'absent';
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return 'permission';
    }
    if (typeof code === 'string') {
        return 'io';
    }
    // No errno and not a JSON syntax error: the validator rejected the payload.
    return 'schema';
}
/**
 * A retry only helps a failure a re-read could plausibly resolve. An absent or unreadable
 * file is a deterministic deployment state — retrying burns hot-path latency for nothing.
 */
function isRetryable(failure) {
    return failure !== 'absent' && failure !== 'permission';
}
function backoffFor(backoffMs, completedAttempt) {
    return completedAttempt <= backoffMs.length ? backoffMs[completedAttempt - 1] : 0;
}
const sleepSlot = (() => {
    try {
        return new Int32Array(new SharedArrayBuffer(4));
    }
    catch {
        return null;
    }
})();
/**
 * Synchronous backoff. These readers are synchronous by contract (apps call them
 * from non-async auth paths), so the wait has to be synchronous too. It is only ever
 * reached after a failed attempt, never on the healthy path.
 */
function sleepSync(ms) {
    if (ms <= 0 || sleepSlot == null) {
        return;
    }
    Atomics.wait(sleepSlot, 0, 0, ms);
}
function readCached(file, full, before, validate) {
    const hit = cache.get(file);
    if (!hit || !sameFingerprint(hit.fingerprint, before)) {
        return null;
    }
    if (elapsedMs() - hit.readAtMs > CACHE_TTL_MS) {
        return null;
    }
    try {
        const value = validate(hit.value);
        const after = fingerprint(fs_1.default.statSync(full, { bigint: true }));
        if (!sameFingerprint(before, after)) {
            throw new UnstableSnapshotError('control file changed while its cached snapshot was checked');
        }
        return { ok: true, value, raw: hit.value };
    }
    catch (error) {
        cache.delete(file);
        return { ok: false, error };
    }
}
function readFresh(file, full, before, validate) {
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(full, 'utf8'));
        const value = validate(raw);
        const after = fingerprint(fs_1.default.statSync(full, { bigint: true }));
        if (!sameFingerprint(before, after)) {
            throw new UnstableSnapshotError('control file changed while it was being read');
        }
        cache.set(file, { fingerprint: after, value: raw, readAtMs: elapsedMs() });
        return { ok: true, value, raw };
    }
    catch (error) {
        return { ok: false, error };
    }
}
function serveLastGood(file, graceMs, validate) {
    if (graceMs <= 0) {
        return null;
    }
    const good = lastGood.get(file);
    if (!good) {
        return null;
    }
    const ageMs = elapsedMs() - good.validatedAtMs;
    if (ageMs > graceMs) {
        // Past the window, drop it so it can never be resurrected by a later clock read.
        lastGood.delete(file);
        return null;
    }
    try {
        return { value: validate(good.value), ageMs };
    }
    catch {
        return null;
    }
}
/**
 * The bounded attempt loop: either a fresh validated snapshot, or the terminal failure
 * the whole budget ended on. Retries only the classes a re-read could resolve.
 */
function attemptStableRead(file, options, validate) {
    const full = path_1.default.join(controlDir(), file);
    const attempts = Math.max(1, options.attempts ?? 1);
    const backoffMs = options.backoffMs ?? [];
    let lastError;
    let lastFailure = 'io';
    let used = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        used = attempt;
        let before;
        try {
            before = fingerprint(fs_1.default.statSync(full, { bigint: true }));
        }
        catch (err) {
            lastError = err;
            lastFailure = classify(err);
            if (!isRetryable(lastFailure)) {
                break;
            }
            if (attempt < attempts) {
                sleepSync(backoffFor(backoffMs, attempt));
            }
            continue;
        }
        const cached = readCached(file, full, before, validate);
        const result = cached ?? readFresh(file, full, before, validate);
        if (result.ok) {
            lastGood.set(file, { value: result.raw, validatedAtMs: elapsedMs() });
            failures.delete(file);
            return { ok: true, stale: false, value: result.value, fingerprint: before };
        }
        lastError = result.error;
        lastFailure = classify(result.error);
        if (!isRetryable(lastFailure)) {
            break;
        }
        if (attempt < attempts) {
            sleepSync(backoffFor(backoffMs, attempt));
        }
    }
    return { failure: lastFailure, error: lastError, attempts: used, failedAtMs: elapsedMs() };
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
function readStable(file, options = {}) {
    const validate = options.validate ?? ((value) => value);
    // A failure this recent has already spent the whole retry budget; spending it again
    // per request is what turns an outage into an event-loop stall.
    const recent = failures.get(file);
    const remembered = recent != null && elapsedMs() - recent.failedAtMs <= FAILURE_TTL_MS ? recent : null;
    const outcome = remembered ?? attemptStableRead(file, options, validate);
    if ('ok' in outcome) {
        return outcome;
    }
    if (remembered == null) {
        failures.set(file, outcome);
    }
    const { failure: lastFailure, error: lastError, attempts: used } = outcome;
    const graced = serveLastGood(file, options.graceMs ?? 0, validate);
    if (graced) {
        return { ok: true, stale: true, value: graced.value, ageMs: graced.ageMs };
    }
    // An absent optional bundle is an ordinary state, not an incident; everything else
    // names the failure class so an operator can tell a torn write from a bad mount.
    if (lastFailure !== 'absent' && options.logFailure !== false) {
        (0, config_1.getLogger)().warn({ err: lastError, file, attempts: used, failure: lastFailure }, '[control] failed to read a stable, valid control file snapshot');
    }
    return { ok: false, failure: lastFailure, error: lastError, attempts: used };
}
/** Convenience wrapper for tolerant callers: a failed read is indistinguishable from absent. */
function readRaw(file, options = {}) {
    const result = readStable(file, options);
    return result.ok ? result.value : null;
}
function invalidateReadCache(file) {
    cache.delete(file);
    // A publication supersedes the pre-write snapshot: replaying it inside the grace
    // window could serve a denylist that predates the revocation just written.
    lastGood.delete(file);
    // The bundle just changed, so a remembered failure is stale evidence — drop it or a
    // successful republication would keep denying for the rest of the failure window.
    failures.delete(file);
}
function clearReadCache() {
    cache.clear();
    lastGood.clear();
    failures.clear();
}
