import {
  ulid,
  type RedisLike,
  type TelemetrySink,
  createRedisListSink,
  drainBuffer,
} from '../telemetry/buffer'

// ── Usage / journey analytics ─────────────────────────────────────────────────
// A second telemetry stream that mirrors the AI-call pipeline, sharing the generic
// buffer plumbing in ../telemetry/buffer (do NOT fork it). Usage events originate
// in the BROWSER (route changes + actions), so unlike AI telemetry they reach the
// store via a same-origin POST to the ControlPlane ingest endpoint; ControlPlane
// then buffers them onto `usage:buffer` with `createUsageSink` and a scheduled
// drain (`shipUsageEvents`) writes them to its own DB. The record `id` is the
// dedup key (the client tags each event with a ULID before sending).

export { ulid, type RedisLike }

/** Surface the event was emitted from. WebView modules report as the web surface. */
export type UsageSurface = 'web' | 'phone' | 'ipad'

/** A screen view (route change) or an in-screen action (a tracked interaction). */
export type UsageEventType = 'view' | 'action'

/**
 * THE usage-analytics contract — the exact shape the ControlPlane `/api/usage`
 * ingest endpoint expects. Built once per tracked event in the client. Mirrors
 * `AiCallRecord`: `id` is the ULID dedup key, `ts` is the client event time.
 */
export interface UsageEvent {
  /** Sortable ULID (client-generated). Dedup key downstream. */
  id: string
  /** ISO-8601 timestamp of the event (client clock). */
  ts: string
  /** Originating app key (e.g. 'finpulse'). */
  app: string
  /**
   * End-user the event belongs to. The client MAY send null; ControlPlane
   * resolves the authoritative userId from the pulse-token at ingest and never
   * trusts a client-supplied value for attribution.
   */
  userId?: string | null
  /** Which surface emitted it. */
  surface: UsageSurface
  /** Canonical screen key (app-local, e.g. 'accounts'), resolved from the nav registry. */
  screenKey: string
  /** Previous screen key, for transition/path analysis. Null on the first view of a session. */
  fromScreenKey?: string | null
  /** 'view' = a screen visit; 'action' = a tracked in-screen interaction. */
  type: UsageEventType
  /** Action name when type === 'action' (e.g. 'export-csv'). */
  action?: string | null
  /** Dwell time on the PRIOR screen in ms, attached to the next 'view'. */
  durationMs?: number | null
  /** Server-assigned session id (filled during sessionization; absent from client). */
  sessionId?: string | null
  /** Small, non-PII contextual bag (e.g. { tab: 'wealth' }). Redaction is the caller's job. */
  meta?: Record<string, unknown> | null
}

/** Shared Redis list key for the usage buffer (lives in ControlPlane's Redis). */
export const USAGE_BUFFER_KEY = 'usage:buffer'

/** Default inactivity gap (ms) that demarcates a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000

/**
 * A sink that LPUSHes each UsageEvent (as JSON) onto the Redis buffer. Used by the
 * ControlPlane ingest route to queue validated events off the hot path. See
 * `createRedisListSink` for the generic contract.
 */
export function createUsageSink(redis: RedisLike, key: string = USAGE_BUFFER_KEY): TelemetrySink<UsageEvent> {
  return createRedisListSink<UsageEvent>(redis, key)
}

/**
 * Drain up to `batchSize` buffered UsageEvents and hand them to `postFn` (which
 * persists them — for usage this writes to ControlPlane's own DB). At-least-once;
 * dedup by event id. See `drainBuffer` for the generic contract.
 */
export function shipUsageEvents(
  redis: RedisLike,
  postFn: (batch: UsageEvent[]) => Promise<void>,
  batchSize: number = 500,
  key: string = USAGE_BUFFER_KEY,
): Promise<number> {
  return drainBuffer<UsageEvent>({ redis, postFn, batchSize, key })
}

/**
 * Server-side sessionization. Given a user's events (any order), sort by ts and
 * split into sessions wherever the gap between consecutive events exceeds
 * `gapMs`. Returns the events sorted, each stamped with a deterministic
 * `sessionId` (the ULID-style id is derived from the first event's id so repeated
 * runs over the same data are stable). Pure + side-effect free.
 */
export function sessionize(events: UsageEvent[], gapMs: number = SESSION_GAP_MS): UsageEvent[] {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  let sessionId: string | null = null
  let prevMs = 0
  return sorted.map((e) => {
    const ms = Date.parse(e.ts)
    if (sessionId === null || (Number.isFinite(ms) && ms - prevMs > gapMs)) {
      // New session: key it off this event's id so it's stable across recomputes.
      sessionId = `s_${e.id}`
    }
    prevMs = Number.isFinite(ms) ? ms : prevMs
    return { ...e, sessionId }
  })
}
