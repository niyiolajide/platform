"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_GAP_MS = exports.USAGE_BUFFER_KEY = exports.ulid = void 0;
exports.createUsageSink = createUsageSink;
exports.shipUsageEvents = shipUsageEvents;
exports.sessionize = sessionize;
const buffer_1 = require("../telemetry/buffer");
Object.defineProperty(exports, "ulid", { enumerable: true, get: function () { return buffer_1.ulid; } });
/** Shared Redis list key for the usage buffer (lives in ControlPlane's Redis). */
exports.USAGE_BUFFER_KEY = 'usage:buffer';
/** Default inactivity gap (ms) that demarcates a new session. */
exports.SESSION_GAP_MS = 30 * 60 * 1000;
/**
 * A sink that LPUSHes each UsageEvent (as JSON) onto the Redis buffer. Used by the
 * ControlPlane ingest route to queue validated events off the hot path. See
 * `createRedisListSink` for the generic contract.
 */
function createUsageSink(redis, key = exports.USAGE_BUFFER_KEY) {
    return (0, buffer_1.createRedisListSink)(redis, key);
}
/**
 * Drain up to `batchSize` buffered UsageEvents and hand them to `postFn` (which
 * persists them — for usage this writes to ControlPlane's own DB). At-least-once;
 * dedup by event id. See `drainBuffer` for the generic contract.
 */
function shipUsageEvents(redis, postFn, batchSize = 500, key = exports.USAGE_BUFFER_KEY) {
    return (0, buffer_1.drainBuffer)(redis, postFn, batchSize, key);
}
/**
 * Server-side sessionization. Given a user's events (any order), sort by ts and
 * split into sessions wherever the gap between consecutive events exceeds
 * `gapMs`. Returns the events sorted, each stamped with a deterministic
 * `sessionId` (the ULID-style id is derived from the first event's id so repeated
 * runs over the same data are stable). Pure + side-effect free.
 */
function sessionize(events, gapMs = exports.SESSION_GAP_MS) {
    const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let sessionId = null;
    let prevMs = 0;
    return sorted.map((e) => {
        const ms = Date.parse(e.ts);
        if (sessionId === null || (Number.isFinite(ms) && ms - prevMs > gapMs)) {
            // New session: key it off this event's id so it's stable across recomputes.
            sessionId = `s_${e.id}`;
        }
        prevMs = Number.isFinite(ms) ? ms : prevMs;
        return { ...e, sessionId };
    });
}
