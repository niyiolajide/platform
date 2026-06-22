import { randomBytes } from 'crypto'
import { getLogger } from '../config'
import { createAnonymizer } from './anonymize'

// ── AI-call telemetry ─────────────────────────────────────────────────────────
// A provider-AGNOSTIC, off-hot-path record of every AI call. `runCascade` emits one
// record per attempt, but any caller (e.g. real-estate-monitor's Stagehand chain,
// which skips the cascade) can build + emit an AiCallRecord directly via
// `recordAiCall` — the contract is decoupled from the cascade resolver.
//
// Design invariants (locked):
//  - The lib stays OFFLINE-FIRST: a sink is INJECTED by the app; with no sink,
//    recordAiCall is a no-op. Nothing here ever throws on the hot path.
//  - Payloads are ANONYMIZED in the client (so callers that skip the cascade
//    anonymizer are still protected). The anonymizer is idempotent over already-
//    masked text (placeholders aren't re-detected), so double-masking is safe.
//  - The sink ships records off the hot path (e.g. LPUSH to a Redis buffer that a
//    scheduled job batches to the Hub). At-least-once + dedup by `id` downstream.

/**
 * THE telemetry contract — the exact shape the Hub ingest endpoint expects. Built
 * once per AI attempt. `prompt`/`response` are anonymized and present only when
 * payload logging is on.
 */
export interface AiCallRecord {
  /** Sortable unique id (ULID-style). Used downstream as the dedup key. */
  id: string
  /** ISO-8601 timestamp of the attempt. */
  ts: string
  /** Originating app (e.g. 'vantage'); defaults from env APP_NAME. */
  app: string
  /** End-user the call was made for, if any. */
  userId?: string | null
  /** What the call was for (e.g. 'digest', 'scrape-extract'). */
  purpose: string
  /** 'cascade' = emitted by runCascade; 'direct' = a caller outside the cascade. */
  caller: 'cascade' | 'direct'
  /** Which cascade tier (main/fast); absent for direct callers. */
  tier?: 'main' | 'fast'
  /** Provider kind (e.g. 'anthropic', 'gemini', 'ollama'). */
  provider: string
  /** Concrete model id used. */
  model: string
  /** 1-based attempt index within the cascade (1 for a direct call). */
  attempt: number
  /** Outcome: 'ok' (answered), 'empty' (null/refused), 'error' (threw). */
  status: 'ok' | 'empty' | 'error'
  /** Error message when status='error'. */
  error?: string | null
  /** Wall-clock latency of the attempt in ms. */
  latencyMs: number
  /** Provider-reported input token count, when available. */
  tokensIn?: number
  /** Provider-reported output token count, when available. */
  tokensOut?: number
  /** Best-effort ESTIMATED cost in cents (omitted for unpriced models). */
  costCentsEst?: number
  /** ANONYMIZED prompt text. Present only when payload logging is on. */
  prompt?: string
  /** ANONYMIZED response text. Present only when payload logging is on. */
  response?: string
}

/** A telemetry sink. MUST NOT throw (recordAiCall guards, but be defensive). */
export type AiTelemetrySink = (r: AiCallRecord) => void

let sink: AiTelemetrySink | null = null

/**
 * Install (or clear, with null) the process-wide telemetry sink. Apps call this
 * once at startup, typically with `createRedisSink(getRedis())`. With no sink,
 * `recordAiCall` is a no-op — the lib remains fully offline/standalone.
 */
export function setAiTelemetrySink(fn: AiTelemetrySink | null): void {
  sink = fn
}

/** Whether a sink is installed (cheap guard the cascade uses to skip record-build). */
export function hasAiTelemetrySink(): boolean {
  return sink != null
}

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
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i] % 32]
  return out
}

/** Generate a ULID-style sortable, collision-resistant id. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/**
 * Anonymize a record's prompt/response (idempotent) and hand it to the sink. NEVER
 * throws: a missing sink is a silent no-op, and any sink/anonymizer error is logged
 * and swallowed so telemetry can never break an AI call. A fresh anonymizer per
 * record gives prompt+response a consistent token mapping within that record.
 */
export function recordAiCall(record: AiCallRecord): void {
  if (!sink) return
  try {
    const r = { ...record }
    if (r.prompt != null || r.response != null) {
      const anon = createAnonymizer()
      // Mask prompt first so its tokens are reused in the response mask (stable map).
      if (r.prompt != null) r.prompt = anon.mask(r.prompt)
      if (r.response != null) r.response = anon.mask(r.response)
    }
    sink(r)
  } catch (err) {
    try {
      getLogger().warn({ err }, '[ai/telemetry] sink threw (swallowed)')
    } catch {
      /* logging must never break a call either */
    }
  }
}

// ── Optional, dependency-light Redis helpers ──────────────────────────────────
// We do NOT depend on ioredis. Apps inject any client exposing these methods (the
// node-redis / ioredis call shapes both satisfy this). Buffer key is shared.

export const AI_TELEMETRY_BUFFER_KEY = 'ai:telemetry:buffer'

/** Minimal Redis surface needed to buffer + ship telemetry. */
export interface RedisLike {
  lpush(key: string, ...values: string[]): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
}

/**
 * A sink that LPUSHes each record (as JSON) onto a Redis list buffer. Fire-and-
 * forget: the returned sink never throws and never awaits (a rejected lpush is
 * caught + logged), so it stays off the hot path. Pair with `shipBuffer` from a
 * scheduled job to drain the buffer to the Hub.
 */
export function createRedisSink(redis: RedisLike, key: string = AI_TELEMETRY_BUFFER_KEY): AiTelemetrySink {
  return (r: AiCallRecord) => {
    Promise.resolve()
      .then(() => redis.lpush(key, JSON.stringify(r)))
      .catch((err) => {
        try {
          getLogger().warn({ err }, '[ai/telemetry] redis lpush failed (dropped)')
        } catch {
          /* ignore */
        }
      })
  }
}

/**
 * Drain up to `batchSize` buffered records and hand them to `postFn` (which ships
 * them to the Hub). On a successful post the shipped slice is LTRIMmed off the
 * buffer (at-least-once: trim only after the post resolves, so a crash mid-ship
 * re-ships — the Hub dedups by record id). Oldest-first: records are LPUSHed, so
 * the tail of the list is the oldest; we read+trim the tail. Returns the count
 * shipped. A post failure leaves the buffer intact (records retried next tick).
 */
export async function shipBuffer(
  redis: RedisLike,
  postFn: (batch: AiCallRecord[]) => Promise<void>,
  batchSize: number = 200,
  key: string = AI_TELEMETRY_BUFFER_KEY,
): Promise<number> {
  if (batchSize <= 0) return 0
  // Oldest `batchSize` entries live at the tail (lpush prepends). lrange returns
  // them newest→oldest, so reverse to ship oldest-first.
  const raw = (await redis.lrange(key, -batchSize, -1)).slice().reverse()
  if (raw.length === 0) return 0
  const batch: AiCallRecord[] = []
  for (const s of raw) {
    try {
      batch.push(JSON.parse(s) as AiCallRecord)
    } catch {
      /* skip a corrupt entry rather than wedge the whole buffer */
    }
  }
  if (batch.length > 0) await postFn(batch)
  // Drop the shipped tail: keep everything from index 0 up to before the tail slice.
  await redis.ltrim(key, 0, -raw.length - 1)
  return batch.length
}
