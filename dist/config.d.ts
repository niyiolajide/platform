export interface PlatformLogger {
    warn: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
}
export declare function configurePlatform(opts: {
    logger?: PlatformLogger;
}): void;
export declare function getLogger(): PlatformLogger;
/** A pulse-token verification key: a key id + its PEM-encoded RSA public key. */
export interface PulsePublicKey {
    kid: string;
    pem: string;
}
/** API keys + the pulse-token signing/verification material — read live from env. */
export declare const keys: {
    anthropicApiKey: () => string;
    geminiApiKey: () => string;
    sharedJwtSecret: () => string;
    /**
     * ControlPlane RSA private signing key (PKCS8 PEM), base64-encoded in
     * PULSE_TOKEN_PRIVATE_KEY_B64. Present ONLY in the ControlPlane container — apps
     * never receive it, so they can verify but cannot mint. Empty string if unset.
     */
    pulsePrivateKey: () => string;
    /**
     * ControlPlane RSA public verification keys from PULSE_TOKEN_PUBLIC_KEYS — a JSON array of
     * `{kid, pem}` where `pem` is a base64-encoded SPKI PEM. Non-secret; shipped to
     * every container. Multiple entries support zero-downtime key rotation (verifiers
     * accept any listed key; the hub signs with one `kid`). Returns [] if unset/invalid.
     */
    pulsePublicKeys: () => PulsePublicKey[];
};
