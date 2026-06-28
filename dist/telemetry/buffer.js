"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ulid = ulid;
exports.createRedisListSink = createRedisListSink;
exports.drainBuffer = drainBuffer;
const crypto_1 = require("crypto");
const config_1 = require("../config");
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
    for (let i = 0; i < 16; i++) {
        out += CROCKFORD[bytes[i] % 32];
    }
    return out;
}
/** Generate a ULID-style sortable, collision-resistant id (server-side). */
function ulid(now = Date.now()) {
    return encodeTime(now) + encodeRandom();
}
/**
 * A sink that LPUSHes each record (as JSON) onto a Redis list buffer. Fire-and-
 * forget: the returned sink never throws and never awaits (a rejected lpush is
 * caught + logged), so it stays off the hot path. Pair with `drainBuffer` from a
 * scheduled job to drain the buffer.
 */
function createRedisListSink(redis, key, serialize = (record) => JSON.stringify(record)) {
    return (r) => {
        Promise.resolve()
            .then(() => redis.lpush(key, serialize(r)))
            .catch((err) => {
            try {
                (0, config_1.getLogger)().warn({ err, key }, '[telemetry] redis lpush failed (dropped)');
            }
            catch {
                /* ignore */
            }
        });
    };
}
async function drainBuffer(opts) {
    const { redis, postFn, batchSize, key, parse = (raw) => raw } = opts;
    if (batchSize <= 0) {
        return 0;
    }
    // Oldest `batchSize` entries live at the tail (lpush prepends). lrange returns
    // them newest→oldest, so reverse to ship oldest-first.
    const raw = (await redis.lrange(key, -batchSize, -1)).slice().reverse();
    if (raw.length === 0) {
        return 0;
    }
    const batch = [];
    for (const s of raw) {
        try {
            const parsed = JSON.parse(s);
            const record = parse(parsed);
            if (record != null) {
                batch.push(record);
            }
        }
        catch {
            /* skip a corrupt entry rather than wedge the whole buffer */
        }
    }
    if (batch.length > 0) {
        await postFn(batch);
    }
    // Drop the shipped tail: keep everything from index 0 up to before the tail slice.
    await redis.ltrim(key, 0, -raw.length - 1);
    return batch.length;
}
