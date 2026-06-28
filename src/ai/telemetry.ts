import { getLogger } from '../config'
import { createAnonymizer } from './anonymize'
import {
  ulid,
  type RedisLike,
  type TelemetrySink,
  createRedisListSink,
  drainBuffer,
} from '../telemetry/buffer'

// AI telemetry builds on the generic buffer plumbing in ../telemetry/buffer.
// `ulid` + `RedisLike` are re-exported here so existing `@niyi/platform/ai`
// imports keep working unchanged; the AI-typed sink/ship helpers below are thin
// aliases over the generic core (no duplication — see the usage-events stream in
// ../analytics for the parallel binding).
export { ulid, type RedisLike }

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
  /** Originating app (e.g. 'finpulse'); defaults from env APP_NAME. */
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
  /**
   * Title-Case word runs that survived masking — *possible* person names the
   * KNOWN_NAMES allow-list missed and that therefore reached the provider
   * unmasked. Surfaced for triage in the Hub's AI Logs (grow KNOWN_NAMES from
   * these). Heuristic + Title-Case-only → undercounts. Absent/empty when none.
   * NOTE: these are themselves possible PII; they're recorded because they're the
   * triage signal and already appear in the stored `prompt` when payloads are on.
   */
  unmaskedNameCandidates?: string[]
}

/** A telemetry sink. MUST NOT throw (recordAiCall guards, but be defensive). */
export type AiTelemetrySink = TelemetrySink<AiCallRecord>

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

// ── AI-typed bindings of the generic buffer plumbing ──────────────────────────
// Thin aliases over ../telemetry/buffer so the public `@niyi/platform/ai` surface
// is unchanged. The buffer key stays shared/stable across apps.

export const AI_TELEMETRY_BUFFER_KEY = 'ai:telemetry:buffer'

/**
 * A sink that LPUSHes each AiCallRecord (as JSON) onto a Redis list buffer.
 * Fire-and-forget; pair with `shipBuffer` from a scheduled job. See
 * `createRedisListSink` for the generic contract.
 */
export function createRedisSink(redis: RedisLike, key: string = AI_TELEMETRY_BUFFER_KEY): AiTelemetrySink {
  return createRedisListSink<AiCallRecord>(redis, key)
}

/**
 * Drain up to `batchSize` buffered AiCallRecords and ship them via `postFn`
 * (at-least-once; the Hub dedups by record id). See `drainBuffer` for the generic
 * contract.
 */
export function shipBuffer(
  redis: RedisLike,
  postFn: (batch: AiCallRecord[]) => Promise<void>,
  batchSize: number = 200,
  key: string = AI_TELEMETRY_BUFFER_KEY,
): Promise<number> {
  return drainBuffer<AiCallRecord>(redis, postFn, batchSize, key)
}
