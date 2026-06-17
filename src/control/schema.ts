import { z } from 'zod'

// ── Control-bundle contract ───────────────────────────────────────────────────
// These zod schemas are the SINGLE source of truth for the files the hub publishes
// to the shared `control/` volume and that every app reads. The hub (writer) and
// the apps (readers) both import these, so the contract cannot drift. Every file
// carries a `schemaVersion`; readers are tolerant (defaults fill missing fields)
// so an older reader survives a newer file and vice-versa.

export const AI_SETTINGS_SCHEMA = z.object({
  schemaVersion: z.number().int().default(1),
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
  // Revoked hub-token jti values, each with the token's exp (epoch seconds) so
  // the hub can prune entries once they can no longer be presented.
  revoked: z.array(z.object({ jti: z.string(), exp: z.number().int() })).default([]),
})
export type Revocations = z.infer<typeof REVOCATIONS_SCHEMA>
