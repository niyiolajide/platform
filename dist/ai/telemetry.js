"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_TELEMETRY_BUFFER_KEY = exports.ulid = void 0;
exports.setAiTelemetrySink = setAiTelemetrySink;
exports.hasAiTelemetrySink = hasAiTelemetrySink;
exports.recordAiCall = recordAiCall;
exports.createRedisSink = createRedisSink;
exports.shipBuffer = shipBuffer;
const config_1 = require("../config");
const anonymize_1 = require("./anonymize");
const buffer_1 = require("../telemetry/buffer");
Object.defineProperty(exports, "ulid", { enumerable: true, get: function () { return buffer_1.ulid; } });
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
/**
 * Anonymize a record's prompt/response (idempotent) and hand it to the sink. NEVER
 * throws: a missing sink is a silent no-op, and any sink/anonymizer error is logged
 * and swallowed so telemetry can never break an AI call. A fresh anonymizer per
 * record gives prompt+response a consistent token mapping within that record.
 */
function recordAiCall(record) {
    if (!sink) {
        return;
    }
    try {
        const r = { ...record };
        if (r.prompt != null || r.response != null) {
            const anon = (0, anonymize_1.createAnonymizer)();
            // Mask prompt first so its tokens are reused in the response mask (stable map).
            if (r.prompt != null) {
                r.prompt = anon.mask(r.prompt);
            }
            if (r.response != null) {
                r.response = anon.mask(r.response);
            }
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
// ── AI-typed bindings of the generic buffer plumbing ──────────────────────────
// Thin aliases over ../telemetry/buffer so the public `@niyi/platform/ai` surface
// is unchanged. The buffer key stays shared/stable across apps.
exports.AI_TELEMETRY_BUFFER_KEY = 'ai:telemetry:buffer';
/**
 * A sink that LPUSHes each AiCallRecord (as JSON) onto a Redis list buffer.
 * Fire-and-forget; pair with `shipBuffer` from a scheduled job. See
 * `createRedisListSink` for the generic contract.
 */
function createRedisSink(redis, key = exports.AI_TELEMETRY_BUFFER_KEY) {
    return (0, buffer_1.createRedisListSink)(redis, key);
}
/**
 * Drain up to `batchSize` buffered AiCallRecords and ship them via `postFn`
 * (at-least-once; the Hub dedups by record id). See `drainBuffer` for the generic
 * contract.
 */
function shipBuffer(redis, postFn, batchSize = 200, key = exports.AI_TELEMETRY_BUFFER_KEY) {
    return (0, buffer_1.drainBuffer)({ redis, postFn, batchSize, key });
}
