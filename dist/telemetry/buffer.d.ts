/** Generate a ULID-style sortable, collision-resistant id (server-side). */
export declare function ulid(now?: number): string;
/** Minimal Redis surface needed to buffer + ship telemetry. */
export interface RedisLike {
    lpush(key: string, ...values: string[]): Promise<unknown>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    ltrim(key: string, start: number, stop: number): Promise<unknown>;
}
/** A telemetry sink for record type T. MUST NOT throw. */
export type TelemetrySink<T> = (r: T) => void;
/**
 * A sink that LPUSHes each record (as JSON) onto a Redis list buffer. Fire-and-
 * forget: the returned sink never throws and never awaits (a rejected lpush is
 * caught + logged), so it stays off the hot path. Pair with `drainBuffer` from a
 * scheduled job to drain the buffer.
 */
export declare function createRedisListSink<T>(redis: RedisLike, key: string, serialize?: (record: T) => string): TelemetrySink<T>;
/**
 * Drain up to `batchSize` buffered records and hand them to `postFn`. On a
 * successful post the shipped slice is LTRIMmed off the buffer (at-least-once:
 * trim only after the post resolves, so a crash mid-ship re-ships — downstream
 * dedups by record id). Oldest-first: records are LPUSHed, so the tail of the
 * list is the oldest; we read+trim the tail. Returns the count shipped. A post
 * failure leaves the buffer intact (records retried next tick).
 */
export interface DrainBufferOptions<T> {
    redis: RedisLike;
    postFn: (batch: T[]) => Promise<void>;
    batchSize: number;
    key: string;
    parse?: (raw: unknown) => T | null;
}
export declare function drainBuffer<T>(opts: DrainBufferOptions<T>): Promise<number>;
