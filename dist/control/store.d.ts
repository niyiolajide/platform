import { type AiSettings, type NotifySettings, type Revocations } from './schema';
export declare function readAiSettings(): AiSettings;
/** Did the AI settings come from the published file or env/defaults? (drift signal) */
export declare function aiConfigSource(): 'file' | 'env-default';
export declare function readNotifySettings(): NotifySettings;
export declare function readRevocations(): Revocations;
export declare function isRevoked(jti: string | undefined | null): boolean;
export declare function publishAiSettings(s: AiSettings): void;
export declare function publishNotifySettings(s: NotifySettings): void;
/** Replace the revocation list, pruning entries whose token has already expired. */
export declare function publishRevocations(r: Revocations): void;
/** Add a single jti to the revocation list (hub only). */
export declare function revokeJti(jti: string, exp: number): void;
/** Test/maintenance helper — clears the mtime cache. */
export declare function _clearCache(): void;
