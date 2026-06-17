export interface PlatformLogger {
    warn: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
}
export declare function configurePlatform(opts: {
    logger?: PlatformLogger;
}): void;
export declare function getLogger(): PlatformLogger;
/** A hub verification key: a key id + its PEM-encoded RSA public key. */
export interface HubPublicKey {
    kid: string;
    pem: string;
}
/** API keys + the hub-token signing/verification material — read live from env. */
export declare const keys: {
    anthropicApiKey: () => string;
    geminiApiKey: () => string;
    sharedJwtSecret: () => string;
    /**
     * Hub RSA private signing key (PKCS8 PEM), base64-encoded in
     * HUB_TOKEN_PRIVATE_KEY_B64. Present ONLY in the auth-service container — apps
     * never receive it, so they can verify but cannot mint. Empty string if unset.
     */
    hubPrivateKey: () => string;
    /**
     * Hub RSA public verification keys from HUB_TOKEN_PUBLIC_KEYS — a JSON array of
     * `{kid, pem}` where `pem` is a base64-encoded SPKI PEM. Non-secret; shipped to
     * every container. Multiple entries support zero-downtime key rotation (verifiers
     * accept any listed key; the hub signs with one `kid`). Returns [] if unset/invalid.
     */
    hubPublicKeys: () => HubPublicKey[];
};
