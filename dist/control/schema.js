"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPS_SCHEMA = exports.APP_INFO_SCHEMA = exports.NAV_ITEM_SCHEMA = exports.REVOCATIONS_SCHEMA = exports.NOTIFY_SETTINGS_SCHEMA = exports.NOTIFY_CHANNEL = exports.AI_SETTINGS_SCHEMA = exports.OLLAMA_SCHEMA = exports.CASCADES_SCHEMA = exports.DEFAULT_CASCADES = exports.CASCADE_STEP_SCHEMA = exports.PROVIDER_KIND = void 0;
const zod_1 = require("zod");
// ── Control-bundle contract ───────────────────────────────────────────────────
// These zod schemas are the SINGLE source of truth for the files the hub publishes
// to the shared `control/` volume and that every app reads. The hub (writer) and
// the apps (readers) both import these, so the contract cannot drift. Every file
// carries a `schemaVersion`; readers are tolerant (defaults fill missing fields)
// so an older reader survives a newer file and vice-versa.
// ── AI provider cascade ───────────────────────────────────────────────────────
// The model-selection priority is a single ordered list per tier. Each step names
// a provider + a concrete model; the resolver walks the list top-to-bottom at call
// time, falling to the next step on any failure (outage, quota, empty/refusal).
// This replaces the old (provider + fallbackEnabled + per-provider model) scheme;
// the legacy scalar fields below are retained, derived from the cascade, so older
// consumers that read `anthropicModel` etc. keep working.
exports.PROVIDER_KIND = zod_1.z.enum(['gemini', 'anthropic', 'ollama']);
exports.CASCADE_STEP_SCHEMA = zod_1.z.object({
    provider: exports.PROVIDER_KIND,
    model: zod_1.z.string().min(1),
});
// Default priority: fast cloud → quality cloud → free local (survives a cloud
// outage). Gemini leads; Claude is the cross-provider fallback; Ollama (on-LAN,
// no key, no anonymization) is the last-resort tail.
exports.DEFAULT_CASCADES = {
    main: [
        { provider: 'gemini', model: 'gemini-2.5-pro' },
        { provider: 'gemini', model: 'gemini-2.5-flash' },
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'ollama', model: 'qwen3:30b-a3b' },
    ],
    fast: [
        { provider: 'gemini', model: 'gemini-2.5-flash' },
        { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'ollama', model: 'qwen3.5:9b' },
    ],
};
exports.CASCADES_SCHEMA = zod_1.z
    .object({
    main: zod_1.z.array(exports.CASCADE_STEP_SCHEMA).min(1).default(exports.DEFAULT_CASCADES.main),
    fast: zod_1.z.array(exports.CASCADE_STEP_SCHEMA).min(1).default(exports.DEFAULT_CASCADES.fast),
})
    .default({ main: exports.DEFAULT_CASCADES.main, fast: exports.DEFAULT_CASCADES.fast });
// Local Ollama connection (no API key). `keepAlive` is passed through to Ollama:
// -1 pins the model in VRAM so the intermittent fallback stays warm (avoids the
// multi-second cold-load); a string like "30m" or seconds as a number also work.
exports.OLLAMA_SCHEMA = zod_1.z
    .object({
    baseUrl: zod_1.z.string().default('http://media001:80'),
    keepAlive: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).default(-1),
})
    .default({ baseUrl: 'http://media001:80', keepAlive: -1 });
exports.AI_SETTINGS_SCHEMA = zod_1.z.object({
    schemaVersion: zod_1.z.number().int().default(1),
    // The ordered model-selection priority — the source of truth for the resolver.
    cascades: exports.CASCADES_SCHEMA,
    ollama: exports.OLLAMA_SCHEMA,
    // Reversibly tokenize PII (emails/phones/SSNs/cards/IBANs/IPs/addresses/names)
    // out of every prompt+system before it leaves the host for a model API, then
    // restore it in the response. On by default. Monetary amounts are never masked.
    // (Local Ollama steps skip masking — data never leaves the LAN.)
    anonymizeRequests: zod_1.z.boolean().default(true),
    // Runtime PII name lists (hub-managed via the AI Logs triage UI; read offline by
    // the anonymizer). `maskNames`: extra person names to mask, UNION the lib's built-in
    // seed. `notPersonNames`: Title-Case runs to NOT flag as possible names (warner
    // deny-list). Both default empty → behavior identical to the seed-only allow-list.
    maskNames: zod_1.z.array(zod_1.z.string()).default([]),
    notPersonNames: zod_1.z.array(zod_1.z.string()).default([]),
    // ── AI-call telemetry / logging (hub-managed) ───────────────────────────────
    // When on, runCascade emits an AiCallRecord per attempt to the configured
    // telemetry sink (no-op if unconfigured). When `logPayloads` is on, the record
    // carries the ANONYMIZED prompt + response text; when off, payloads are omitted
    // (metadata only). Retention days are read by the Hub's prune job (the lib does
    // not prune — it just records). On by default for ALL apps.
    logAiCalls: zod_1.z.boolean().default(true),
    logPayloads: zod_1.z.boolean().default(true),
    aiLogRetentionDays: zod_1.z.number().int().min(1).default(30),
    aiLogPayloadRetentionDays: zod_1.z.number().int().min(1).default(30),
    // ── Legacy fields (deprecated) ──────────────────────────────────────────────
    // Retained for back-compat: the store derives a cascade from these when a file
    // predates `cascades`, and backfills them from the active cascade so consumers
    // still reading `anthropicModel` etc. keep working. Prefer `cascades`.
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
    // Revoked pulse-token jti values, each with the token's exp (epoch seconds) so
    // the hub can prune entries once they can no longer be presented.
    revoked: zod_1.z.array(zod_1.z.object({ jti: zod_1.z.string(), exp: zod_1.z.number().int() })).default([]),
});
// A single in-app navigation destination. ONE source-of-truth for an app's nav,
// consumed by every surface (the app's own web sidebar + ⌘K, the unified mobile
// shell's per-app tabs, the iPad sidebar) so they can't drift. `group` buckets the
// item in grouped surfaces (free-form per app, e.g. 'money'|'wealth'|'insights' for
// Vantage); null = ungrouped/chrome. `icon` = lucide name (web), `emoji` = glyph
// (mobile). `frequencyRank` orders within a surface (lower = earlier). `surfaces`
// limits where it appears; `tab` marks the (≤5) phone bottom tabs.
exports.NAV_ITEM_SCHEMA = zod_1.z.object({
    key: zod_1.z.string(),
    label: zod_1.z.string(),
    href: zod_1.z.string(),
    icon: zod_1.z.string().optional(),
    emoji: zod_1.z.string().optional(),
    group: zod_1.z.string().nullable().optional(),
    frequencyRank: zod_1.z.number().optional(),
    surfaces: zod_1.z.array(zod_1.z.enum(['web', 'phone', 'ipad'])).optional(),
    tab: zod_1.z.boolean().optional(),
});
// App registry — drives the cross-app AppSwitcher in every app's shell. `url` is
// browser-facing (what the user navigates to), so it's editable here (not hardcoded
// to localhost). `icon` is a lucide icon name. `nav` (optional) is the app's own
// in-app navigation, published here so the app's web shell + the mobile shell
// consume ONE definition (anti-drift); absent = the app bundles its own.
exports.APP_INFO_SCHEMA = zod_1.z.object({
    key: zod_1.z.string(),
    name: zod_1.z.string(),
    url: zod_1.z.string(),
    icon: zod_1.z.string().optional(),
    nav: zod_1.z.array(exports.NAV_ITEM_SCHEMA).optional(),
});
exports.APPS_SCHEMA = zod_1.z.object({
    schemaVersion: zod_1.z.number().int().default(1),
    apps: zod_1.z.array(exports.APP_INFO_SCHEMA).default([]),
});
