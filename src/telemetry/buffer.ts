import { randomBytes } from 'crypto'
import { getLogger } from '../config'

// ── Generic off-hot-path telemetry buffer ─────────────────────────────────────
// Record-type-agnostic plumbing shared by every telemetry stream (AI calls,
// usage events, …). The contract is identical across streams: fire-and-forget
// LPUSH onto a Redis list buffer, then a scheduled drain that ships the oldest
// records in batches and trims only after the post resolves (at-least-once; the
// downstream dedups by record `id`). Nothing here knows or cares about the record
// shape — it's pure JSON over a list — so a new stream just picks its own buffer
// key + postFn. Do NOT fork this; type it via the generic parameter.

// ── Sortable unique id (ULID-style) ───────────────────────────────────────────
// 26-char Crockford-base32 ULID: 48-bit ms timestamp + 80 bits of randomness.
// Lexicographically sortable by time, collision-resistant, dependency-free.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ms: number): string {
  let out = ''
  let t = ms
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD[t % 32] + out
    t = Math.floor(t / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) {out += CROCKFORD[bytes[i] % 32]}
  return out
}

/** Generate a ULID-style sortable, collision-resistant id (server-side). */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

// ── Redis surface ─────────────────────────────────────────────────────────────
// We do NOT depend on ioredis. Apps inject any client exposing these methods (the
// node-redis / ioredis call shapes both satisfy this).

/** Minimal Redis surface needed to buffer + ship telemetry. */
export interface RedisLike {
  lpush(key: string, ...values: string[]): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
}

/** A telemetry sink for record type T. MUST NOT throw. */
export type TelemetrySink<T> = (r: T) => void

/**
 * A sink that LPUSHes each record (as JSON) onto a Redis list buffer. Fire-and-
 * forget: the returned sink never throws and never awaits (a rejected lpush is
 * caught + logged), so it stays off the hot path. Pair with `drainBuffer` from a
 * scheduled job to drain the buffer.
 */
export function createRedisListSink<T>(
  redis: RedisLike,
  key: string,
  serialize: (record: T) => string = (record) => JSON.stringify(record),
): TelemetrySink<T> {
  return (r: T) => {
    Promise.resolve()
      .then(() => redis.lpush(key, serialize(r)))
      .catch((err: unknown) => {
        try {
          getLogger().warn({ err, key }, '[telemetry] redis lpush failed (dropped)')
        } catch {
          /* ignore */
        }
      })
  }
}

/**
 * Drain up to `batchSize` buffered records and hand them to `postFn`. On a
 * successful post the shipped slice is LTRIMmed off the buffer (at-least-once:
 * trim only after the post resolves, so a crash mid-ship re-ships — downstream
 * dedups by record id). Oldest-first: records are LPUSHed, so the tail of the
 * list is the oldest; we read+trim the tail. Returns the count shipped. A post
 * failure leaves the buffer intact (records retried next tick).
 */
export interface DrainBufferOptions<T> {
  redis: RedisLike,
  postFn: (batch: T[]) => Promise<void>,
  batchSize: number,
  key: string,
  parse?: (raw: unknown) => T | null,
}

export async function drainBuffer<T>(opts: DrainBufferOptions<T>): Promise<number> {
  const { redis, postFn, batchSize, key, parse = (raw): T | null => raw as T } = opts
  if (batchSize <= 0) {return 0}
  // Oldest `batchSize` entries live at the tail (lpush prepends). lrange returns
  // them newest→oldest, so reverse to ship oldest-first.
  const raw = (await redis.lrange(key, -batchSize, -1)).slice().reverse()
  if (raw.length === 0) {return 0}
  const batch: T[] = []
  for (const s of raw) {
    try {
      const parsed: unknown = JSON.parse(s)
      const record = parse(parsed)
      if (record != null) {batch.push(record)}
    } catch {
      /* skip a corrupt entry rather than wedge the whole buffer */
    }
  }
  if (batch.length > 0) {await postFn(batch)}
  // Drop the shipped tail: keep everything from index 0 up to before the tail slice.
  await redis.ltrim(key, 0, -raw.length - 1)
  return batch.length
}
