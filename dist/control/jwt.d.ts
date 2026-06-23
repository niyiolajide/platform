export interface PulseJwtPayload {
    userId: string;
    email: string;
    fullName?: string;
    iss: string;
    jti?: string;
    iat?: number;
    exp?: number;
}
/**
 * Verify a pulse-token: an RS256 (asymmetric) OR HS256 (legacy shared-secret)
 * signature, plus `iss==='hub'`, not expired, and jti not revoked. Returns the
 * payload or null.
 */
export declare function verifyPulseToken(token: string | undefined | null): PulseJwtPayload | null;
