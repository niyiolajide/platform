import { z } from 'zod'

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

export const PROVIDER_KIND = z.enum(['gemini', 'anthropic', 'ollama'])
export type ProviderKind = z.infer<typeof PROVIDER_KIND>

export const CASCADE_STEP_SCHEMA = z.object({
  provider: PROVIDER_KIND,
  model: z.string().min(1),
})
export type CascadeStep = z.infer<typeof CASCADE_STEP_SCHEMA>

// Default priority: fast cloud → quality cloud → free local (survives a cloud
// outage). Gemini leads; Claude is the cross-provider fallback; Ollama (on-LAN,
// no key, no anonymization) is the last-resort tail.
export const DEFAULT_CASCADES: { main: CascadeStep[]; fast: CascadeStep[] } = {
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
}

export const CASCADES_SCHEMA = z
  .object({
    main: z.array(CASCADE_STEP_SCHEMA).min(1).default(DEFAULT_CASCADES.main),
    fast: z.array(CASCADE_STEP_SCHEMA).min(1).default(DEFAULT_CASCADES.fast),
  })
  .default({ main: DEFAULT_CASCADES.main, fast: DEFAULT_CASCADES.fast })

// Local Ollama connection (no API key). `keepAlive` is passed through to Ollama:
// -1 pins the model in VRAM so the intermittent fallback stays warm (avoids the
// multi-second cold-load); a string like "30m" or seconds as a number also work.
export const OLLAMA_SCHEMA = z
  .object({
    baseUrl: z.string().default('http://media001:80'),
    keepAlive: z.union([z.string(), z.number()]).default(-1),
  })
  .default({ baseUrl: 'http://media001:80', keepAlive: -1 })

export const AI_SETTINGS_SCHEMA = z.object({
  schemaVersion: z.number().int().default(1),
  // The ordered model-selection priority — the source of truth for the resolver.
  cascades: CASCADES_SCHEMA,
  ollama: OLLAMA_SCHEMA,
  // Reversibly tokenize PII (emails/phones/SSNs/cards/IBANs/IPs/addresses/names)
  // out of every prompt+system before it leaves the host for a model API, then
  // restore it in the response. On by default. Monetary amounts are never masked.
  // (Local Ollama steps skip masking — data never leaves the LAN.)
  anonymizeRequests: z.boolean().default(true),
  // Runtime PII name lists (hub-managed via the AI Logs triage UI; read offline by
  // the anonymizer). `maskNames`: extra person names to mask, UNION the lib's built-in
  // seed. `notPersonNames`: Title-Case runs to NOT flag as possible names (warner
  // deny-list). Both default empty → behavior identical to the seed-only allow-list.
  maskNames: z.array(z.string()).default([]),
  notPersonNames: z.array(z.string()).default([]),
  // ── AI-call telemetry / logging (hub-managed) ───────────────────────────────
  // When on, runCascade emits an AiCallRecord per attempt to the configured
  // telemetry sink (no-op if unconfigured). When `logPayloads` is on, the record
  // carries the ANONYMIZED prompt + response text; when off, payloads are omitted
  // (metadata only). Retention days are read by the Hub's prune job (the lib does
  // not prune — it just records). On by default for ALL apps.
  logAiCalls: z.boolean().default(true),
  logPayloads: z.boolean().default(true),
  aiLogRetentionDays: z.number().int().min(1).default(30),
  aiLogPayloadRetentionDays: z.number().int().min(1).default(30),
  // ── Legacy fields (deprecated) ──────────────────────────────────────────────
  // Retained for back-compat: the store derives a cascade from these when a file
  // predates `cascades`, and backfills them from the active cascade so consumers
  // still reading `anthropicModel` etc. keep working. Prefer `cascades`.
  provider: z.enum(['anthropic', 'gemini']).default('anthropic'),
  fallbackEnabled: z.boolean().default(true),
  anthropicModel: z.string().default('claude-sonnet-4-6'),
  anthropicModelFast: z.string().default('claude-haiku-4-5-20251001'),
  geminiModel: z.string().default('gemini-2.5-flash'),
  geminiModelFast: z.string().default('gemini-2.5-flash'),
  geminiModelFallback: z.string().default('gemini-2.5-flash-lite'),
})
export type AiSettings = z.infer<typeof AI_SETTINGS_SCHEMA>

export const NOTIFY_CHANNEL = z.enum(['telegram', 'email', 'signal'])
export type NotifyChannel = z.infer<typeof NOTIFY_CHANNEL>

export const NOTIFY_SETTINGS_SCHEMA = z.object({
  schemaVersion: z.number().int().default(1),
  // Per-app/per-level routing: which channels fire. Empty → fall back to defaults.
  routes: z
    .array(
      z.object({
        app: z.string().optional(), // omitted = all apps
        minLevel: z.enum(['info', 'warn', 'error']).default('info'),
        channels: z.array(NOTIFY_CHANNEL).default(['telegram']),
      }),
    )
    .default([{ minLevel: 'info', channels: ['telegram'] }]),
  // Quiet hours in 24h local time; non-error notifications are suppressed within.
  quietHours: z
    .object({ start: z.number().min(0).max(23), end: z.number().min(0).max(23) })
    .nullable()
    .default(null),
})
export type NotifySettings = z.infer<typeof NOTIFY_SETTINGS_SCHEMA>

export const REVOCATIONS_SCHEMA = z.object({
  schemaVersion: z.number().int().default(1),
  // Revoked pulse-token jti values, each with the token's exp (epoch seconds) so
  // the hub can prune entries once they can no longer be presented.
  revoked: z.array(z.object({ jti: z.string(), exp: z.number().int() })).default([]),
})
export type Revocations = z.infer<typeof REVOCATIONS_SCHEMA>

// A single in-app navigation destination. ONE source-of-truth for an app's nav,
// consumed by every surface (the app's own web sidebar + ⌘K, the unified mobile
// shell's per-app tabs, the iPad sidebar) so they can't drift. `group` buckets the
// item in grouped surfaces (free-form per app, e.g. 'money'|'wealth'|'insights' for
// Vantage); null = ungrouped/chrome. `icon` = lucide name (web), `emoji` = glyph
// (mobile). `frequencyRank` orders within a surface (lower = earlier). `surfaces`
// limits where it appears; `tab` marks the (≤5) phone bottom tabs.
export const NAV_ITEM_SCHEMA = z.object({
  key: z.string(),
  label: z.string(),
  href: z.string(),
  icon: z.string().optional(),
  emoji: z.string().optional(),
  group: z.string().nullable().optional(),
  frequencyRank: z.number().optional(),
  surfaces: z.array(z.enum(['web', 'phone', 'ipad'])).optional(),
  tab: z.boolean().optional(),
})
export type NavItemInfo = z.infer<typeof NAV_ITEM_SCHEMA>

// App registry — drives the cross-app AppSwitcher in every app's shell. `url` is
// browser-facing (what the user navigates to), so it's editable here (not hardcoded
// to localhost). `icon` is a lucide icon name. `nav` (optional) is the app's own
// in-app navigation, published here so the app's web shell + the mobile shell
// consume ONE definition (anti-drift); absent = the app bundles its own.
export const APP_INFO_SCHEMA = z.object({
  key: z.string(),
  name: z.string(),
  url: z.string(),
  icon: z.string().optional(),
  nav: z.array(NAV_ITEM_SCHEMA).optional(),
})
export type AppInfo = z.infer<typeof APP_INFO_SCHEMA>

export const APPS_SCHEMA = z.object({
  schemaVersion: z.number().int().default(1),
  apps: z.array(APP_INFO_SCHEMA).default([]),
})
export type AppsRegistry = z.infer<typeof APPS_SCHEMA>
