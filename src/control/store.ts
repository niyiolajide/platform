import fs from 'fs'
import path from 'path'
import { clearReadCache, readRaw } from './reader'
import { writeRaw } from './writer'
import {
  AI_SETTINGS_SCHEMA,
  NOTIFY_SETTINGS_SCHEMA,
  APPS_SCHEMA,
  type AiSettings,
  type CascadeStep,
  type ProviderKind,
  type NotifySettings,
  type AppInfo,
} from './schema'

// ── Control-bundle file-bus ───────────────────────────────────────────────────
// The hub publishes JSON to a shared volume (default /control); apps read it
// OFFLINE — no network call, so the hub being down never blocks an app. Reads are
// fingerprint-cached (cheap on the hot path, near-real-time after a hub edit) and
// validated for snapshot stability (reader.ts); publication is temp + fsync + rename
// (writer.ts). The security-critical revocation denylist lives in revocations.ts —
// the bundles here are deliberately TOLERANT: a missing file means env/defaults.

const CONTROL_DIR = (): string => process.env.CONTROL_DIR ?? '/control'

/**
 * Optional bundles are tolerant by design, but a torn read of a file that DOES exist
 * must not be mistaken for absence — that silently downgrades a published config to
 * env defaults. Retry the transient classes; a genuinely absent file still
 * short-circuits on the first attempt and costs nothing.
 */
const OPTIONAL_READ = { attempts: 3, backoffMs: [2, 10] as const }

// AI settings: file overrides env defaults; schema applies hard defaults. Tolerant.
function aiEnvDefaults(): Partial<AiSettings> {
  return {
    anonymizeRequests:
      process.env.AI_ANONYMIZE_REQUESTS != null
        ? process.env.AI_ANONYMIZE_REQUESTS !== 'false'
        : undefined,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? undefined,
    anthropicModelFast: process.env.ANTHROPIC_MODEL_FAST ?? undefined,
    geminiModel: process.env.GEMINI_MODEL ?? undefined,
    geminiModelFast: process.env.GEMINI_MODEL_FAST ?? undefined,
    geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK ?? undefined,
  }
}

const LEGACY_MODEL_KEYS = [
  'provider',
  'fallbackEnabled',
  'anthropicModel',
  'anthropicModelFast',
  'geminiModel',
  'geminiModelFast',
  'geminiModelFallback',
] as const

function hasLegacyModelOverride(raw: Record<string, unknown>): boolean {
  return LEGACY_MODEL_KEYS.some((k) => raw[k] != null)
}

function dedupeSteps(arr: CascadeStep[]): CascadeStep[] {
  const seen = new Set<string>()
  return arr.filter((x) => {
    const k = `${x.provider}:${x.model}`
    if (seen.has(k)) {return false}
    seen.add(k)
    return true
  })
}

// Build a cascade from the deprecated scalar fields so a pre-`cascades` ai.json
// keeps its old behavior: provider order honored, fallback toggled, Ollama tail
// appended. Used only when a file/env sets legacy fields but no explicit cascade.
function synthesizeCascades(s: AiSettings): { main: CascadeStep[]; fast: CascadeStep[] } {
  const anthroMain: CascadeStep = { provider: 'anthropic', model: s.anthropicModel }
  const anthroFast: CascadeStep = { provider: 'anthropic', model: s.anthropicModelFast }
  const gemMain: CascadeStep = { provider: 'gemini', model: s.geminiModel }
  const gemMainFb: CascadeStep = { provider: 'gemini', model: s.geminiModelFallback }
  const gemFast: CascadeStep = { provider: 'gemini', model: s.geminiModelFast }
  const ollMain: CascadeStep = { provider: 'ollama', model: 'qwen3:30b-a3b' }
  const ollFast: CascadeStep = { provider: 'ollama', model: 'qwen3.5:9b' }
  const geminiFirst = s.provider === 'gemini'

  if (!s.fallbackEnabled) {
    return geminiFirst
      ? { main: dedupeSteps([gemMain, gemMainFb]), fast: dedupeSteps([gemFast]) }
      : { main: [anthroMain], fast: [anthroFast] }
  }
  return geminiFirst
    ? {
        main: dedupeSteps([gemMain, gemMainFb, anthroMain, ollMain]),
        fast: dedupeSteps([gemFast, anthroFast, ollFast]),
      }
    : {
        main: dedupeSteps([anthroMain, gemMain, gemMainFb, ollMain]),
        fast: dedupeSteps([anthroFast, gemFast, ollFast]),
      }
}

// Keep the deprecated scalar fields consistent with the active cascade so older
// consumers (e.g. apps reading `anthropicModel`) see the model the cascade uses.
function backfillLegacy(s: AiSettings): AiSettings {
  const firstOf = (tier: CascadeStep[], p: ProviderKind) =>
    tier.find((x) => x.provider === p)?.model
  return {
    ...s,
    anthropicModel: firstOf(s.cascades.main, 'anthropic') ?? s.anthropicModel,
    anthropicModelFast: firstOf(s.cascades.fast, 'anthropic') ?? s.anthropicModelFast,
    geminiModel: firstOf(s.cascades.main, 'gemini') ?? s.geminiModel,
    geminiModelFast: firstOf(s.cascades.fast, 'gemini') ?? s.geminiModelFast,
  }
}

// Parsed-settings memo keyed by ai.json mtime: avoids re-running zod (+ the
// back-compat reconciliation) on every call within a request. Invalidated by a
// file write (mtime changes) or _clearCache (tests / env changes).
let settingsMemo: { mtimeMs: number; value: AiSettings } | null = null

export function readAiSettings(): AiSettings {
  const full = path.join(CONTROL_DIR(), 'ai.json')
  let mtimeMs = -1
  try {
    mtimeMs = fs.statSync(full).mtimeMs
  } catch {
    /* absent → sentinel -1 (env/defaults only) */
  }
  if (settingsMemo?.mtimeMs === mtimeMs) {return settingsMemo.value}

  const env = aiEnvDefaults()
  const rawFile = readRaw<Record<string, unknown>>('ai.json', OPTIONAL_READ) ?? {}
  let settings = AI_SETTINGS_SCHEMA.parse({ ...env, ...rawFile })

  // If the file predates `cascades` but set legacy model fields, derive a cascade
  // from them so behavior is preserved until the cascade is published explicitly.
  const explicitCascades = rawFile.cascades != null
  if (!explicitCascades && (hasLegacyModelOverride(rawFile) || hasLegacyModelOverride(env))) {
    settings = { ...settings, cascades: synthesizeCascades(settings) }
  }
  settings = backfillLegacy(settings)

  settingsMemo = { mtimeMs, value: settings }
  return settings
}

/** Did the AI settings come from the published file or env/defaults? (drift signal) */
export function aiConfigSource(): 'file' | 'env-default' {
  return readRaw('ai.json', OPTIONAL_READ) != null ? 'file' : 'env-default'
}

/** The cross-app registry for the shell AppSwitcher (from control/apps.json). */
export function readApps(): AppInfo[] {
  const file = readRaw<Record<string, unknown>>('apps.json', OPTIONAL_READ) ?? {}
  return APPS_SCHEMA.parse(file).apps
}

export function readNotifySettings(): NotifySettings {
  const file = readRaw<Record<string, unknown>>('notify.json', OPTIONAL_READ) ?? {}
  return NOTIFY_SETTINGS_SCHEMA.parse(file)
}

// ── Writers (hub only) ────────────────────────────────────────────────────────

export function publishAiSettings(s: AiSettings): void {
  writeRaw('ai.json', AI_SETTINGS_SCHEMA.parse(s))
}

export function publishNotifySettings(s: NotifySettings): void {
  writeRaw('notify.json', NOTIFY_SETTINGS_SCHEMA.parse(s))
}

/** Test/maintenance helper — clears the read caches and the parsed-settings memo. */
export function _clearCache(): void {
  clearReadCache()
  settingsMemo = null
}
