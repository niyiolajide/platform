import { type ReadFailureClass } from './reader';
import { type Revocations } from './schema';
export declare class RevocationsUnavailableError extends Error {
    /** Why the read failed — an operator needs `absent` vs `permission` vs `parse`. */
    readonly failure: ReadFailureClass;
    constructor(failure: ReadFailureClass);
}
/**
 * The current revocation denylist.
 *
 * THROWS `RevocationsUnavailableError` when no valid snapshot can be obtained — an
 * unreadable denylist is never reported as an empty one. Within the grace window a
 * previously validated snapshot is returned and alarmed instead. Callers doing
 * read-modify-write must not use this; see `revokeJti`.
 */
export declare function readRevocations(): Revocations;
export type JtiRevocationStatus = 'clear' | 'revoked' | 'unavailable';
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
export declare function checkJtiRevocation(jti: string | undefined | null): JtiRevocationStatus;
export declare function isRevoked(jti: string | undefined | null): boolean;
/**
 * Replace the revocation list, pruning entries whose token has already expired.
 *
 * The INPUT is validated first, before pruning. Pruning rebuilds the bundle as
 * `{schemaVersion: 1, revoked: <filtered>}`, which would launder an unknown shape into
 * a valid-looking v1 bundle: a JS caller passing a v2 payload whose revocations live
 * under a different key would publish an EMPTY denylist that parses perfectly. Validate
 * what the caller actually handed us, not what we rebuilt from it.
 */
export declare function publishRevocations(r: Revocations): void;
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
export declare function revokeJti(jti: string, exp: number): void;
