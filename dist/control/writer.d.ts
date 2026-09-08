import { type FileFingerprint } from './reader';
export declare function matchesExpected(file: string, expected: FileFingerprint | null): boolean;
/** Absolute path of a control file in the currently configured control directory. */
export declare function controlFilePath(file: string): string;
/**
 * True only while this process holds the publication lock for `file` AND the
 * lockfile still carries our ownership token. Publishers check this immediately
 * before their rename: a lock broken as stale mid-operation belongs to its
 * successor now, and proceeding to rename would clobber the successor's verified
 * write. Aborting instead (the caller retries under a fresh acquisition) is what
 * makes stale-takeover safe on the holder side.
 */
export declare function controlLockHeld(file: string): boolean;
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
export declare function withControlLock<T>(file: string, fn: () => T): T;
/** Stage `value` as JSON in a unique temp file: returns its path and inode. */
export declare function stageTempFile(file: string, value: unknown): {
    tmp: string;
    ino: bigint;
};
/** Best-effort removal of a staged temp file; never masks the publication result. */
export declare function discardStagedFile(tmp: string): void;
/**
 * Atomically publish a staged temp file by creating the target with it. Uses `link`
 * (which fails EEXIST when the target already exists) instead of `rename` (which
 * would silently replace a file a concurrent publisher just created). Durability of
 * the new directory entry is fsynced like the rename path.
 */
export declare function linkStagedFile(file: string, tmp: string): void;
/** Rename a staged temp file into place and fsync the directory entry. */
export declare function commitStagedFile(file: string, tmp: string): void;
/**
 * Hardlink-pin the live file to a unique backup name. The pin keeps the pre-write
 * inode observable (and its bytes recoverable) even after our rename orphans it —
 * which is what makes a concurrent in-place landing detectable AND recoverable.
 * Throws ENOENT when the live file is absent.
 */
export declare function pinBackupLink(file: string): string;
/** Pin an existing file; absence alone is eligible for atomic bootstrap. */
export declare function pinExistingFile(file: string): string | null;
/** Best-effort removal of a backup pin; never masks the publication result. */
export declare function unpinBackupLink(backup: string): void;
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
export declare function writeRaw(file: string, value: unknown, expected?: FileFingerprint | null): boolean;
