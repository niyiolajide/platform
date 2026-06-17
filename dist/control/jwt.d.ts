export interface HubJwtPayload {
    userId: string;
    email: string;
    fullName?: string;
    iss: string;
    jti?: string;
    iat?: number;
    exp?: number;
}
/**
 * Verify a hub-token: HS256 signature against SHARED_JWT_SECRET, `iss==='hub'`,
 * not expired, and jti not revoked. Returns the payload or null.
 */
export declare function verifyHubToken(token: string | undefined | null): HubJwtPayload | null;
