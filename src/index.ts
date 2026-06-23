// Top-level barrel. Prefer the subpath imports (`@niyi/platform/ai`, `/notify`,
// `/control`) in apps; this re-exports the common surface for convenience.
// Note: the AI settings symbols come via `./ai`; from `./control` we re-export
// only the non-AI surface to avoid duplicate-export conflicts.
export { configurePlatform, getLogger, keys, type PlatformLogger } from './config'
export * from './ai'
export * from './notify'
export {
  NOTIFY_CHANNEL,
  type NotifyChannel,
  NOTIFY_SETTINGS_SCHEMA,
  type NotifySettings,
  REVOCATIONS_SCHEMA,
  type Revocations,
  readNotifySettings,
  readRevocations,
  isRevoked,
  publishAiSettings,
  publishNotifySettings,
  publishRevocations,
  revokeJti,
  _clearCache,
  verifyPulseToken,
  type PulseJwtPayload,
} from './control'
