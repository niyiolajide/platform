import fs from 'fs'
import path from 'path'
import { getLogger } from '../config'
import {
  AI_SETTINGS_SCHEMA,
  NOTIFY_SETTINGS_SCHEMA,
  REVOCATIONS_SCHEMA,
  APPS_SCHEMA,
  type AiSettings,
  type NotifySettings,
  type Revocations,
  type AppInfo,
} from './schema'

// ── Control-bundle file-bus ───────────────────────────────────────────────────
// The hub publishes JSON to a shared volume (default /control); apps read it
// OFFLINE — no network call, so the hub being down never blocks an app. Reads are
// mtime-cached (cheap on the hot path, near-real-time after a hub edit). Writes are
// atomic (temp + rename) and only the hub mounts the dir read-write.

const CONTROL_DIR = () => process.env.CONTROL_DIR || '/control'

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
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value
  try {
    const value = JSON.parse(fs.readFileSync(full, 'utf8'))
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
    anthropicModel: process.env.ANTHROPIC_MODEL || undefined,
    anthropicModelFast: process.env.ANTHROPIC_MODEL_FAST || undefined,
    geminiModel: process.env.GEMINI_MODEL || undefined,
    geminiModelFast: process.env.GEMINI_MODEL_FAST || undefined,
    geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK || undefined,
  }
}

export function readAiSettings(): AiSettings {
  const env = aiEnvDefaults()
  const file = (readRaw('ai.json') as Record<string, unknown> | null) ?? {}
  // Drop undefined env entries so they don't clobber file/schema defaults.
  const envClean = Object.fromEntries(Object.entries(env).filter(([, v]) => v != null))
  return AI_SETTINGS_SCHEMA.parse({ ...envClean, ...file })
}

/** Did the AI settings come from the published file or env/defaults? (drift signal) */
export function aiConfigSource(): 'file' | 'env-default' {
  return readRaw('ai.json') ? 'file' : 'env-default'
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

export function readRevocations(): Revocations {
  const file = (readRaw('revocations.json') as Record<string, unknown> | null) ?? {}
  return REVOCATIONS_SCHEMA.parse(file)
}

export function isRevoked(jti: string | undefined | null): boolean {
  if (!jti) return false
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
    schemaVersion: r.schemaVersion ?? 1,
    revoked: r.revoked.filter((e) => e.exp > now),
  }
  writeRaw('revocations.json', REVOCATIONS_SCHEMA.parse(pruned))
}

/** Add a single jti to the revocation list (hub only). */
export function revokeJti(jti: string, exp: number): void {
  const cur = readRevocations()
  if (cur.revoked.some((e) => e.jti === jti)) return
  publishRevocations({ schemaVersion: cur.schemaVersion, revoked: [...cur.revoked, { jti, exp }] })
}

/** Test/maintenance helper — clears the mtime cache. */
export function _clearCache(): void {
  cache.clear()
}
