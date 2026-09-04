export interface FileFingerprint {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}
/**
 * Why a read failed. Callers need this: an ABSENT bundle is a deployment state a
 * writer may legitimately bootstrap from, while parse/schema/permission failures
 * mean real content exists that we must not clobber or ignore.
 */
export type ReadFailureClass = 'absent' | 'permission' | 'io' | 'parse' | 'schema' | 'unstable';
export type StableRead<T> = {
    ok: true;
    stale: false;
    value: T;
    fingerprint: FileFingerprint;
} | {
    ok: true;
    stale: true;
    value: T;
    ageMs: number;
} | {
    ok: false;
    failure: ReadFailureClass;
    error: unknown;
    attempts: number;
};
export interface StableReadOptions<T> {
    /** Bounded retry budget for transient failures (torn read, unstable metadata). */
    attempts?: number;
    /** Delay before each retry, indexed by completed attempt. */
    backoffMs?: readonly number[];
    /**
     * Bounded last-known-good window: once the retry budget is spent, a snapshot THIS
     * process already validated may be served for this many ms, flagged `stale`. 0 = off.
     */
    graceMs?: number;
    logFailure?: boolean;
    validate?: (value: unknown) => T;
}
export declare function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean;
/**
 * Current fingerprint of a control file.
 *
 * Three-way ON PURPOSE. A compare-and-set that treats "I could not stat it" as "it is
 * absent" would let a bootstrap write clobber a file another publisher had just
 * created; the caller must be able to fail closed on `error` instead.
 */
export type FingerprintProbe = {
    kind: 'present';
    fingerprint: FileFingerprint;
} | {
    kind: 'absent';
} | {
    kind: 'error';
    error: unknown;
};
export declare function probeFingerprint(file: string): FingerprintProbe;
/**
 * Synchronous backoff. These readers are synchronous by contract (apps call them
 * from non-async auth paths), so the wait has to be synchronous too. It is only ever
 * reached after a failed attempt, never on the healthy path.
 */
export declare function sleepSync(ms: number): void;
/**
 * Read, parse, and validate a stable control-file snapshot.
 *
 * Accepts a snapshot only when the file's metadata is unchanged from immediately
 * before to immediately after the read; failures are never cached. Security-critical
 * callers can add bounded retries with backoff and a bounded last-known-good grace
 * window. The grace window only ever replays a snapshot THIS process already read and
 * validated — an absent or never-valid bundle can never be graced into existence.
 */
export declare function readStable<T = unknown>(file: string, options?: StableReadOptions<T>): StableRead<T>;
/** Convenience wrapper for tolerant callers: a failed read is indistinguishable from absent. */
export declare function readRaw<T = unknown>(file: string, options?: StableReadOptions<T>): T | null;
export declare function invalidateReadCache(file: string): void;
export declare function clearReadCache(): void;
