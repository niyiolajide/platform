/**
 * THE telemetry contract — the exact shape the Hub ingest endpoint expects. Built
 * once per AI attempt. `prompt`/`response` are anonymized and present only when
 * payload logging is on.
 */
export interface AiCallRecord {
    /** Sortable unique id (ULID-style). Used downstream as the dedup key. */
    id: string;
    /** ISO-8601 timestamp of the attempt. */
    ts: string;
    /** Originating app (e.g. 'vantage'); defaults from env APP_NAME. */
    app: string;
    /** End-user the call was made for, if any. */
    userId?: string | null;
    /** What the call was for (e.g. 'digest', 'scrape-extract'). */
    purpose: string;
    /** 'cascade' = emitted by runCascade; 'direct' = a caller outside the cascade. */
    caller: 'cascade' | 'direct';
    /** Which cascade tier (main/fast); absent for direct callers. */
    tier?: 'main' | 'fast';
    /** Provider kind (e.g. 'anthropic', 'gemini', 'ollama'). */
    provider: string;
    /** Concrete model id used. */
    model: string;
    /** 1-based attempt index within the cascade (1 for a direct call). */
    attempt: number;
    /** Outcome: 'ok' (answered), 'empty' (null/refused), 'error' (threw). */
    status: 'ok' | 'empty' | 'error';
    /** Error message when status='error'. */
    error?: string | null;
    /** Wall-clock latency of the attempt in ms. */
    latencyMs: number;
    /** Provider-reported input token count, when available. */
    tokensIn?: number;
    /** Provider-reported output token count, when available. */
    tokensOut?: number;
    /** Best-effort ESTIMATED cost in cents (omitted for unpriced models). */
    costCentsEst?: number;
    /** ANONYMIZED prompt text. Present only when payload logging is on. */
    prompt?: string;
    /** ANONYMIZED response text. Present only when payload logging is on. */
    response?: string;
    /**
     * Title-Case word runs that survived masking — *possible* person names the
     * KNOWN_NAMES allow-list missed and that therefore reached the provider
     * unmasked. Surfaced for triage in the Hub's AI Logs (grow KNOWN_NAMES from
     * these). Heuristic + Title-Case-only → undercounts. Absent/empty when none.
     * NOTE: these are themselves possible PII; they're recorded because they're the
     * triage signal and already appear in the stored `prompt` when payloads are on.
     */
    unmaskedNameCandidates?: string[];
}
/** A telemetry sink. MUST NOT throw (recordAiCall guards, but be defensive). */
export type AiTelemetrySink = (r: AiCallRecord) => void;
/**
 * Install (or clear, with null) the process-wide telemetry sink. Apps call this
 * once at startup, typically with `createRedisSink(getRedis())`. With no sink,
 * `recordAiCall` is a no-op — the lib remains fully offline/standalone.
 */
export declare function setAiTelemetrySink(fn: AiTelemetrySink | null): void;
/** Whether a sink is installed (cheap guard the cascade uses to skip record-build). */
export declare function hasAiTelemetrySink(): boolean;
/** Generate a ULID-style sortable, collision-resistant id. */
export declare function ulid(now?: number): string;
/**
 * Anonymize a record's prompt/response (idempotent) and hand it to the sink. NEVER
 * throws: a missing sink is a silent no-op, and any sink/anonymizer error is logged
 * and swallowed so telemetry can never break an AI call. A fresh anonymizer per
 * record gives prompt+response a consistent token mapping within that record.
 */
export declare function recordAiCall(record: AiCallRecord): void;
export declare const AI_TELEMETRY_BUFFER_KEY = "ai:telemetry:buffer";
/** Minimal Redis surface needed to buffer + ship telemetry. */
export interface RedisLike {
    lpush(key: string, ...values: string[]): Promise<unknown>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    ltrim(key: string, start: number, stop: number): Promise<unknown>;
}
/**
 * A sink that LPUSHes each record (as JSON) onto a Redis list buffer. Fire-and-
 * forget: the returned sink never throws and never awaits (a rejected lpush is
 * caught + logged), so it stays off the hot path. Pair with `shipBuffer` from a
 * scheduled job to drain the buffer to the Hub.
 */
export declare function createRedisSink(redis: RedisLike, key?: string): AiTelemetrySink;
/**
 * Drain up to `batchSize` buffered records and hand them to `postFn` (which ships
 * them to the Hub). On a successful post the shipped slice is LTRIMmed off the
 * buffer (at-least-once: trim only after the post resolves, so a crash mid-ship
 * re-ships — the Hub dedups by record id). Oldest-first: records are LPUSHed, so
 * the tail of the list is the oldest; we read+trim the tail. Returns the count
 * shipped. A post failure leaves the buffer intact (records retried next tick).
 */
export declare function shipBuffer(redis: RedisLike, postFn: (batch: AiCallRecord[]) => Promise<void>, batchSize?: number, key?: string): Promise<number>;
