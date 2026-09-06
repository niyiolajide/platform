import { type ReadFailureClass } from './reader';
import { type Revocations } from './schema';
export { publishRevocations } from './publication';
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
export declare function revokeJti(jti: string, exp: number): void;
