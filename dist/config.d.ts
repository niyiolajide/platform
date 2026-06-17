export interface PlatformLogger {
    warn: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
}
export declare function configurePlatform(opts: {
    logger?: PlatformLogger;
}): void;
export declare function getLogger(): PlatformLogger;
/** API keys + the SHARED_JWT_SECRET — read live from the environment. */
export declare const keys: {
    anthropicApiKey: () => string;
    geminiApiKey: () => string;
    sharedJwtSecret: () => string;
};
