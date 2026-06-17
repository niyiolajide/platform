"use strict";
// Platform-wide injectable config: a logger and the keys read from process.env.
// Apps may call configurePlatform({ logger }) once at startup to route library
// logs through their own logger; otherwise a console-based logger is used.
// API keys are NEVER stored here in a mutable store — they are read live from
// process.env (sourced from the single shared.env file), so rotating a key is a
// restart, not a code change.
Object.defineProperty(exports, "__esModule", { value: true });
exports.keys = void 0;
exports.configurePlatform = configurePlatform;
exports.getLogger = getLogger;
const consoleLogger = {
    warn: (o, m) => console.warn('[platform]', m ?? '', o ?? ''),
    info: (o, m) => console.info('[platform]', m ?? '', o ?? ''),
    error: (o, m) => console.error('[platform]', m ?? '', o ?? ''),
};
let logger = consoleLogger;
function configurePlatform(opts) {
    if (opts.logger)
        logger = opts.logger;
}
function getLogger() {
    return logger;
}
/** API keys + the hub-token signing/verification material — read live from env. */
exports.keys = {
    anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || '',
    geminiApiKey: () => process.env.GEMINI_API_KEY || '',
    sharedJwtSecret: () => process.env.SHARED_JWT_SECRET || '',
    /**
     * Hub RSA private signing key (PKCS8 PEM), base64-encoded in
     * HUB_TOKEN_PRIVATE_KEY_B64. Present ONLY in the auth-service container — apps
     * never receive it, so they can verify but cannot mint. Empty string if unset.
     */
    hubPrivateKey: () => {
        const b64 = process.env.HUB_TOKEN_PRIVATE_KEY_B64;
        return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
    },
    /**
     * Hub RSA public verification keys from HUB_TOKEN_PUBLIC_KEYS — a JSON array of
     * `{kid, pem}` where `pem` is a base64-encoded SPKI PEM. Non-secret; shipped to
     * every container. Multiple entries support zero-downtime key rotation (verifiers
     * accept any listed key; the hub signs with one `kid`). Returns [] if unset/invalid.
     */
    hubPublicKeys: () => {
        const raw = process.env.HUB_TOKEN_PUBLIC_KEYS;
        if (!raw)
            return [];
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr))
                return [];
            return arr
                .filter((e) => e && typeof e.kid === 'string' && typeof e.pem === 'string')
                .map((e) => ({ kid: e.kid, pem: Buffer.from(e.pem, 'base64').toString('utf8') }));
        }
        catch {
            return [];
        }
    },
};
