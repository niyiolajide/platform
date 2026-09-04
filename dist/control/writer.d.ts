import { type FileFingerprint } from './reader';
/**
 * Run `fn` holding an exclusive publication lock for `file` (hub only).
 *
 * Only serializes publishers that go through this helper. ControlPlane's web container
 * publishes revocations with its own in-place overwrite (it cannot create files in the
 * root-owned /control under its exact-file binds), so it does NOT take this lock —
 * which is exactly why the reader validates snapshot stability and the write keeps its
 * compare-and-set.
 */
export declare function withControlLock<T>(file: string, fn: () => T): T;
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
export declare function writeRaw(file: string, value: unknown, expected?: FileFingerprint | null): boolean;
