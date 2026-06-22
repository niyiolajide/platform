"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_TELEMETRY_BUFFER_KEY = void 0;
exports.setAiTelemetrySink = setAiTelemetrySink;
exports.hasAiTelemetrySink = hasAiTelemetrySink;
exports.ulid = ulid;
exports.recordAiCall = recordAiCall;
exports.createRedisSink = createRedisSink;
exports.shipBuffer = shipBuffer;
const crypto_1 = require("crypto");
const config_1 = require("../config");
const anonymize_1 = require("./anonymize");
let sink = null;
/**
 * Install (or clear, with null) the process-wide telemetry sink. Apps call this
 * once at startup, typically with `createRedisSink(getRedis())`. With no sink,
 * `recordAiCall` is a no-op — the lib remains fully offline/standalone.
 */
function setAiTelemetrySink(fn) {
    sink = fn;
}
/** Whether a sink is installed (cheap guard the cascade uses to skip record-build). */
function hasAiTelemetrySink() {
    return sink != null;
}
// ── Sortable unique id (ULID-style) ───────────────────────────────────────────
// 26-char Crockford-base32 ULID: 48-bit ms timestamp + 80 bits of randomness.
// Lexicographically sortable by time, collision-resistant, dependency-free.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function encodeTime(ms) {
    let out = '';
    let t = ms;
    for (let i = 9; i >= 0; i--) {
        out = CROCKFORD[t % 32] + out;
        t = Math.floor(t / 32);
    }
    return out;
}
function encodeRandom() {
    const bytes = (0, crypto_1.randomBytes)(16);
    let out = '';
    for (let i = 0; i < 16; i++)
        out += CROCKFORD[bytes[i] % 32];
    return out;
}
/** Generate a ULID-style sortable, collision-resistant id. */
function ulid(now = Date.now()) {
    return encodeTime(now) + encodeRandom();
}
/**
 * Anonymize a record's prompt/response (idempotent) and hand it to the sink. NEVER
 * throws: a missing sink is a silent no-op, and any sink/anonymizer error is logged
 * and swallowed so telemetry can never break an AI call. A fresh anonymizer per
 * record gives prompt+response a consistent token mapping within that record.
 */
function recordAiCall(record) {
    if (!sink)
        return;
    try {
        const r = { ...record };
        if (r.prompt != null || r.response != null) {
            const anon = (0, anonymize_1.createAnonymizer)();
            // Mask prompt first so its tokens are reused in the response mask (stable map).
            if (r.prompt != null)
                r.prompt = anon.mask(r.prompt);
            if (r.response != null)
                r.response = anon.mask(r.response);
        }
        sink(r);
    }
    catch (err) {
        try {
            (0, config_1.getLogger)().warn({ err }, '[ai/telemetry] sink threw (swallowed)');
        }
        catch {
            /* logging must never break a call either */
        }
    }
}
// ── Optional, dependency-light Redis helpers ──────────────────────────────────
// We do NOT depend on ioredis. Apps inject any client exposing these methods (the
// node-redis / ioredis call shapes both satisfy this). Buffer key is shared.
exports.AI_TELEMETRY_BUFFER_KEY = 'ai:telemetry:buffer';
/**
 * A sink that LPUSHes each record (as JSON) onto a Redis list buffer. Fire-and-
 * forget: the returned sink never throws and never awaits (a rejected lpush is
 * caught + logged), so it stays off the hot path. Pair with `shipBuffer` from a
 * scheduled job to drain the buffer to the Hub.
 */
function createRedisSink(redis, key = exports.AI_TELEMETRY_BUFFER_KEY) {
    return (r) => {
        Promise.resolve()
            .then(() => redis.lpush(key, JSON.stringify(r)))
            .catch((err) => {
            try {
                (0, config_1.getLogger)().warn({ err }, '[ai/telemetry] redis lpush failed (dropped)');
            }
            catch {
                /* ignore */
            }
        });
    };
}
/**
 * Drain up to `batchSize` buffered records and hand them to `postFn` (which ships
 * them to the Hub). On a successful post the shipped slice is LTRIMmed off the
 * buffer (at-least-once: trim only after the post resolves, so a crash mid-ship
 * re-ships — the Hub dedups by record id). Oldest-first: records are LPUSHed, so
 * the tail of the list is the oldest; we read+trim the tail. Returns the count
 * shipped. A post failure leaves the buffer intact (records retried next tick).
 */
async function shipBuffer(redis, postFn, batchSize = 200, key = exports.AI_TELEMETRY_BUFFER_KEY) {
    if (batchSize <= 0)
        return 0;
    // Oldest `batchSize` entries live at the tail (lpush prepends). lrange returns
    // them newest→oldest, so reverse to ship oldest-first.
    const raw = (await redis.lrange(key, -batchSize, -1)).slice().reverse();
    if (raw.length === 0)
        return 0;
    const batch = [];
    for (const s of raw) {
        try {
            batch.push(JSON.parse(s));
        }
        catch {
            /* skip a corrupt entry rather than wedge the whole buffer */
        }
    }
    if (batch.length > 0)
        await postFn(batch);
    // Drop the shipped tail: keep everything from index 0 up to before the tail slice.
    await redis.ltrim(key, 0, -raw.length - 1);
    return batch.length;
}
