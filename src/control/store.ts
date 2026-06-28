import fs from 'fs'
import path from 'path'
import { getLogger } from '../config'
import {
  AI_SETTINGS_SCHEMA,
  NOTIFY_SETTINGS_SCHEMA,
  REVOCATIONS_SCHEMA,
  APPS_SCHEMA,
  type AiSettings,
  type CascadeStep,
  type ProviderKind,
  type NotifySettings,
  type Revocations,
  type AppInfo,
} from './schema'

// ── Control-bundle file-bus ───────────────────────────────────────────────────
// The hub publishes JSON to a shared volume (default /control); apps read it
// OFFLINE — no network call, so the hub being down never blocks an app. Reads are
// mtime-cached (cheap on the hot path, near-real-time after a hub edit). Writes are
// atomic (temp + rename) and only the hub mounts the dir read-write.

const CONTROL_DIR = () => process.env.CONTROL_DIR ?? '/control'

interface CacheEntry {
  mtimeMs: number
  value: unknown
}
const cache = new Map<string, CacheEntry>()

/** Read + parse a control file, mtime-cached. Returns null if absent/unreadable. */
function readRaw(file: string): unknown {
  const full = path.join(CONTROL_DIR(), file)
  let stat: fs.Stats
  try {
    stat = fs.statSync(full)
  } catch {
    return null
  }
  const hit = cache.get(file)
  if (hit?.mtimeMs === stat.mtimeMs) {return hit.value}
  try {
    const value: unknown = JSON.parse(fs.readFileSync(full, 'utf8'))
    cache.set(file, { mtimeMs: stat.mtimeMs, value })
    return value
  } catch (err) {
    getLogger().warn({ err, file }, '[control] failed to read/parse control file')
    return null
  }
}

/** Atomic write of a control file (hub only). */
function writeRaw(file: string, value: unknown): void {
  const dir = CONTROL_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const full = path.join(dir, file)
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, full)
  cache.delete(file)
}

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
  const rawFile = (readRaw('ai.json') as Record<string, unknown> | null) ?? {}
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
  return readRaw('ai.json') != null ? 'file' : 'env-default'
}

/** The cross-app registry for the shell AppSwitcher (from control/apps.json). */
export function readApps(): AppInfo[] {
  const file = (readRaw('apps.json') as Record<string, unknown> | null) ?? {}
  return APPS_SCHEMA.parse(file).apps
}

export function readNotifySettings(): NotifySettings {
  const file = (readRaw('notify.json') as Record<string, unknown> | null) ?? {}
  return NOTIFY_SETTINGS_SCHEMA.parse(file)
}

// Revocation is security-critical: if the file is absent or corrupt the denylist is
// empty, i.e. the system fails OPEN (revoke nothing). That must never be silent — warn
// loudly (throttled so it doesn't spam the hot path) so a deleted/broken bundle surfaces.
let lastRevocationsWarnMs = 0
function warnRevocationsUnavailable(): void {
  const now = Date.now()
  if (now - lastRevocationsWarnMs < 10 * 60 * 1000) {return}
  lastRevocationsWarnMs = now
  getLogger().warn(
    { file: 'revocations.json' },
    '[control] revocations file absent/unreadable — FAILING OPEN (no tokens are being revoked). ' +
      'Check the control bundle is published and mounted.',
  )
}

export function readRevocations(): Revocations {
  const raw = readRaw('revocations.json') as Record<string, unknown> | null
  if (raw == null) {
    // Absent or unparseable (readRaw already logged a parse error). Surface the
    // fail-open security impact explicitly, then return an empty (no-op) denylist.
    warnRevocationsUnavailable()
    return REVOCATIONS_SCHEMA.parse({})
  }
  return REVOCATIONS_SCHEMA.parse(raw)
}

export function isRevoked(jti: string | undefined | null): boolean {
  if (!jti) {return false}
  return readRevocations().revoked.some((r) => r.jti === jti)
}

// ── Writers (hub only) ────────────────────────────────────────────────────────

export function publishAiSettings(s: AiSettings): void {
  writeRaw('ai.json', AI_SETTINGS_SCHEMA.parse(s))
}

export function publishNotifySettings(s: NotifySettings): void {
  writeRaw('notify.json', NOTIFY_SETTINGS_SCHEMA.parse(s))
}

/** Replace the revocation list, pruning entries whose token has already expired. */
export function publishRevocations(r: Revocations): void {
  const now = Math.floor(Date.now() / 1000)
  const pruned: Revocations = {
    schemaVersion: r.schemaVersion,
    revoked: r.revoked.filter((e) => e.exp > now),
  }
  writeRaw('revocations.json', REVOCATIONS_SCHEMA.parse(pruned))
}

/** Add a single jti to the revocation list (hub only). */
export function revokeJti(jti: string, exp: number): void {
  const cur = readRevocations()
  if (cur.revoked.some((e) => e.jti === jti)) {return}
  publishRevocations({ schemaVersion: cur.schemaVersion, revoked: [...cur.revoked, { jti, exp }] })
}

/** Test/maintenance helper — clears the mtime cache. */
export function _clearCache(): void {
  cache.clear()
  settingsMemo = null
}
