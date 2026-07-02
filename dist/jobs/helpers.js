"use strict";
// Pure helpers for the durable-job runner: dedupe keys, backoff math, result
// decoration, retry eligibility, and the handler timeout race. No storage here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.toJson = exports.HANDLER_TIMEOUT_ERROR = exports.MAX_BACKOFF_MS = exports.BASE_BACKOFF_MS = void 0;
exports.validScheduledFor = validScheduledFor;
exports.dedupeKey = dedupeKey;
exports.addMs = addMs;
exports.backoffForAttempt = backoffForAttempt;
exports.decorateResult = decorateResult;
exports.storedResult = storedResult;
exports.retryable = retryable;
exports.runHandlerWithTimeout = runHandlerWithTimeout;
exports.BASE_BACKOFF_MS = 5 * 60 * 1000;
exports.MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Error message stored on runs whose handler exceeded handlerTimeoutMs. */
exports.HANDLER_TIMEOUT_ERROR = 'handler_timeout';
const toJson = (value) => JSON.parse(JSON.stringify(value));
exports.toJson = toJson;
function validScheduledFor(value, now) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? now : date;
}
function dedupeKey(jobName, scheduledFor) {
    return `${jobName}:${scheduledFor.toISOString()}`;
}
function addMs(date, ms) {
    return new Date(date.getTime() + ms);
}
/** Exponential backoff: 5m, 10m, 20m, 40m, capped at 60m. */
function backoffForAttempt(attempt) {
    return Math.min(exports.BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), exports.MAX_BACKOFF_MS);
}
function objectMetadata(value) {
    if (value == null) {
        return {};
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return { value };
}
function decorateResult(result, metadata) {
    return {
        ...result,
        metadata: {
            ...objectMetadata(result.metadata),
            ...metadata,
        },
    };
}
function storedResult(row) {
    const value = row.resultJson;
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const status = value.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'dispatched') {
        return null;
    }
    return value;
}
/** A run may be (re)claimed when queued, past its lock expiry, or past its retry backoff. */
function retryable(row, now) {
    if (row.status === 'running') {
        return row.lockExpiresAt == null || row.lockExpiresAt <= now;
    }
    if (row.status === 'failed') {
        return row.nextRunAt == null || row.nextRunAt <= now;
    }
    return row.status === 'queued';
}
class HandlerTimeoutError extends Error {
    constructor() {
        super(exports.HANDLER_TIMEOUT_ERROR);
        this.name = 'HandlerTimeoutError';
    }
}
/**
 * Race the handler against a wall-clock budget.
 *
 * NOTE: JavaScript cannot cancel an in-flight promise. On timeout the handler
 * keeps running detached — the JobRun row simply stops representing it: the
 * run is marked failed with error='handler_timeout' and the lock is cleared so
 * a future dispatch can reclaim the slot (backoff/maxAttempts apply as for any
 * other failure). Promise.race keeps the losing branch's eventual rejection
 * observed, so no unhandled-rejection warning is emitted.
 */
async function runHandlerWithTimeout(handler, ctx, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            handler(ctx),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => { reject(new HandlerTimeoutError()); }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer != null) {
            clearTimeout(timer);
        }
    }
}
