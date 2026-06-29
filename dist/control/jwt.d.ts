export interface PulseJwtPayload {
    userId: string;
    email: string;
    fullName?: string;
    iss: string;
    jti?: string;
    aud?: string | string[];
    iat?: number;
    nbf?: number;
    exp?: number;
}
export interface PulseJobJwtPayload {
    iss: string;
    purpose: 'job';
    aud?: string | string[];
    jti?: string;
    iat?: number;
    nbf?: number;
    exp?: number;
}
export interface VerifyPulseTokenOptions {
    /**
     * When set, the token's `aud` must equal (or, for an array `aud`, include) this value.
     * Lets a service/job token scoped for app A be rejected at app B. Omit to skip the check.
     */
    expectedAud?: string;
    /**
     * Job-dispatch tokens intentionally carry no user identity. They are accepted only
     * when the caller explicitly asks for the job purpose; ordinary user/session token
     * callers continue to require `userId` and `email`.
     */
    expectedPurpose?: 'job';
}
/**
 * Verify a pulse-token: an RS256 signature against ControlPlane's published key(s),
 * `iss==='controlplane'`, a REQUIRED non-expired `exp`, `nbf` (when present), an
 * optional `expectedAud`, and `jti` not revoked. Returns the payload or null.
 */
export declare function verifyPulseToken(token: string | undefined | null, opts: VerifyPulseTokenOptions & {
    expectedPurpose: 'job';
}): PulseJobJwtPayload | null;
export declare function verifyPulseToken(token: string | undefined | null, opts?: VerifyPulseTokenOptions): PulseJwtPayload | null;
