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
/** API keys + the SHARED_JWT_SECRET — read live from the environment. */
exports.keys = {
    anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || '',
    geminiApiKey: () => process.env.GEMINI_API_KEY || '',
    sharedJwtSecret: () => process.env.SHARED_JWT_SECRET || '',
};
