import { type FileFingerprint } from './reader';
import { type Revocations } from './schema';
export declare function prunedRevocations(r: Revocations): Revocations;
/**
 * Union of denylist snapshots, deduplicated by jti (first occurrence wins, so live
 * state beats orphaned history), pruned and validated. The new jti is appended by
 * the caller before invoking this.
 */
export declare function mergeRevocations(lists: Revocations[]): Revocations;
/** Current bytes behind a history pin, or null when torn/unreadable (retry later). */
export declare function readPinnedRevocations(pin: string): Revocations | null;
/**
 * True when two denylists hold the same jti set (order-insensitive, pruned). The
 * caller merges live ∪ pin ∪ {new} and compares against live: equality proves the
 * pin and the new jti added nothing the live file lacked, so returning early can
 * never orphan unmerged history. Inequality only costs a converging rewrite.
 */
export declare function sameRevocationContent(a: Revocations, b: Revocations): boolean;
/**
 * Guarded publish of an already-merged denylist. Returns true only when the live
 * bundle verifiably contains every unexpired jti from `next` AND from the history
 * pin; false means re-read and re-merge (bounded attempts by the caller). The pin
 * may be null on the bootstrap path, where there is no history to protect.
 */
export declare function guardedPublishRevocations(next: Revocations, expected: FileFingerprint | null, pin: string | null): boolean;
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
export declare function verifyPublishedRevocations(tmpIno: bigint | null, next: Revocations, pin: string | null, base: Revocations | null): boolean;
