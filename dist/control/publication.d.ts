import { type Revocations } from './schema';
/**
 * Replace the revocation list, pruning entries whose token has already expired.
 *
 * The INPUT is validated first, before pruning. Pruning rebuilds the bundle as
 * `{schemaVersion: 1, revoked: <filtered>}`, which would launder an unknown shape into
 * a valid-looking v1 bundle: a JS caller passing a v2 payload whose revocations live
 * under a different key would publish an EMPTY denylist that parses perfectly. Validate
 * what the caller actually handed us, not what we rebuilt from it.
 *
 * Replace-semantics, but never blind and never silently winning: the call pins the
 * live inode, re-checks fingerprint plus lock ownership immediately before the
 * rename, and verifies afterwards — and ANY observed concurrent interference throws
 * a loud conflict instead of reporting success. Retrying the same replace onto a
 * concurrent revoke would erase it while claiming operator intent, and union-
 * merging would corrupt replace intent (un-revoke by omission must keep working),
 * so the only honest recovery is the operator re-issuing the replace knowingly.
 * Transient torn reads retry boundedly; everything else throws on first contact.
 */
export declare function publishRevocations(r: Revocations): void;
