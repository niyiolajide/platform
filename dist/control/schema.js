"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REVOCATIONS_SCHEMA = exports.NOTIFY_SETTINGS_SCHEMA = exports.NOTIFY_CHANNEL = exports.AI_SETTINGS_SCHEMA = void 0;
const zod_1 = require("zod");
// ── Control-bundle contract ───────────────────────────────────────────────────
// These zod schemas are the SINGLE source of truth for the files the hub publishes
// to the shared `control/` volume and that every app reads. The hub (writer) and
// the apps (readers) both import these, so the contract cannot drift. Every file
// carries a `schemaVersion`; readers are tolerant (defaults fill missing fields)
// so an older reader survives a newer file and vice-versa.
exports.AI_SETTINGS_SCHEMA = zod_1.z.object({
    schemaVersion: zod_1.z.number().int().default(1),
    provider: zod_1.z.enum(['anthropic', 'gemini']).default('anthropic'),
    fallbackEnabled: zod_1.z.boolean().default(true),
    anthropicModel: zod_1.z.string().default('claude-sonnet-4-6'),
    anthropicModelFast: zod_1.z.string().default('claude-haiku-4-5-20251001'),
    geminiModel: zod_1.z.string().default('gemini-2.5-flash'),
    geminiModelFast: zod_1.z.string().default('gemini-2.5-flash'),
    geminiModelFallback: zod_1.z.string().default('gemini-2.5-flash-lite'),
});
exports.NOTIFY_CHANNEL = zod_1.z.enum(['telegram', 'email', 'signal']);
exports.NOTIFY_SETTINGS_SCHEMA = zod_1.z.object({
    schemaVersion: zod_1.z.number().int().default(1),
    // Per-app/per-level routing: which channels fire. Empty → fall back to defaults.
    routes: zod_1.z
        .array(zod_1.z.object({
        app: zod_1.z.string().optional(), // omitted = all apps
        minLevel: zod_1.z.enum(['info', 'warn', 'error']).default('info'),
        channels: zod_1.z.array(exports.NOTIFY_CHANNEL).default(['telegram']),
    }))
        .default([{ minLevel: 'info', channels: ['telegram'] }]),
    // Quiet hours in 24h local time; non-error notifications are suppressed within.
    quietHours: zod_1.z
        .object({ start: zod_1.z.number().min(0).max(23), end: zod_1.z.number().min(0).max(23) })
        .nullable()
        .default(null),
});
exports.REVOCATIONS_SCHEMA = zod_1.z.object({
    schemaVersion: zod_1.z.number().int().default(1),
    // Revoked hub-token jti values, each with the token's exp (epoch seconds) so
    // the hub can prune entries once they can no longer be presented.
    revoked: zod_1.z.array(zod_1.z.object({ jti: zod_1.z.string(), exp: zod_1.z.number().int() })).default([]),
});
