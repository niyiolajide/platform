"use strict";
// Durable-job runner — a storage-agnostic port of the RetirementPulse durable
// state machine (src/lib/jobs/durable.ts). `runDurableJob(store, opts)` claims
// exactly one active attempt per (jobName, scheduledFor) slot via a unique
// dedupeKey, short-circuits completed/dead/locked duplicates, reclaims expired
// locks with an optimistic CAS, retries with exponential backoff, and
// dead-letters after maxAttempts. Handlers additionally race a configurable
// wall-clock timeout (see helpers.runHandlerWithTimeout).
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCK_TIMEOUT_MS = exports.DEFAULT_MAX_ATTEMPTS = void 0;
exports.runDurableJob = runDurableJob;
const config_1 = require("../config");
const helpers_1 = require("./helpers");
const types_1 = require("./types");
exports.DEFAULT_MAX_ATTEMPTS = 3;
exports.LOCK_TIMEOUT_MS = 15 * 60 * 1000;
function completedShortCircuit(row) {
    const result = (0, helpers_1.storedResult)(row) ?? { status: 'completed', metadata: row.metadataJson ?? undefined };
    return {
        kind: 'short-circuit',
        result: (0, helpers_1.decorateResult)(result, { jobRunId: row.id, attempts: row.attempts, deduped: true }),
    };
}
async function deadShortCircuit(ctx, row, now) {
    const dead = row.status === 'dead' ? row : await deadLetter(ctx, row, now);
    return {
        kind: 'short-circuit',
        result: {
            status: 'failed',
            error: dead.error ?? 'Job run is dead-lettered',
            metadata: { jobRunId: dead.id, attempts: dead.attempts, deadLettered: true },
        },
    };
}
function activeShortCircuit(row) {
    return {
        kind: 'short-circuit',
        result: {
            status: 'dispatched',
            metadata: {
                jobRunId: row.id,
                attempts: row.attempts,
                deduped: true,
                currentStatus: row.status,
                nextRunAt: row.nextRunAt?.toISOString() ?? null,
            },
        },
    };
}
async function createRun(ctx, args) {
    const { jobName, key, scheduledFor, now, maxAttempts } = args;
    return await ctx.store.create({
        jobName,
        dedupeKey: key,
        scheduledFor,
        status: 'running',
        attempts: 1,
        maxAttempts,
        lockedAt: now,
        lockExpiresAt: (0, helpers_1.addMs)(now, ctx.lockTimeoutMs),
        startedAt: now,
    });
}
async function deadLetter(ctx, row, now) {
    return await ctx.store.update(row.id, {
        status: 'dead',
        finishedAt: now,
        lockExpiresAt: null,
        nextRunAt: null,
    });
}
async function retryClaim(ctx, row, now) {
    // The guard pins {status, attempts}, so `attempts + 1` is the same atomic
    // increment the reference performed with Prisma's { increment: 1 }.
    const claimed = await ctx.store.updateWhere({ id: row.id, status: row.status, attempts: row.attempts }, {
        status: 'running',
        attempts: row.attempts + 1,
        lockedAt: now,
        lockExpiresAt: (0, helpers_1.addMs)(now, ctx.lockTimeoutMs),
        startedAt: now,
        finishedAt: null,
        nextRunAt: null,
        error: null,
    });
    if (claimed !== 1) {
        return {
            kind: 'short-circuit',
            result: {
                status: 'dispatched',
                metadata: { jobRunId: row.id, attempts: row.attempts, deduped: true, currentStatus: 'running' },
            },
        };
    }
    const updated = await ctx.store.findById(row.id);
    if (!updated) {
        throw new Error(`Claimed job run ${row.id} disappeared`);
    }
    return { kind: 'claimed', row: updated };
}
async function claimExisting(ctx, row, now) {
    if (row.status === 'completed') {
        return completedShortCircuit(row);
    }
    if (row.status === 'dead' || (row.status === 'failed' && row.attempts >= row.maxAttempts)) {
        return await deadShortCircuit(ctx, row, now);
    }
    if (!(0, helpers_1.retryable)(row, now)) {
        return activeShortCircuit(row);
    }
    return await retryClaim(ctx, row, now);
}
async function claimRun(ctx, args) {
    try {
        return { kind: 'claimed', row: await createRun(ctx, args) };
    }
    catch (err) {
        if (!(0, types_1.isDedupeConflict)(err)) {
            throw err;
        }
    }
    const existing = await ctx.store.findByDedupeKey(args.key);
    if (!existing) {
        return { kind: 'claimed', row: await createRun(ctx, args) };
    }
    return await claimExisting(ctx, existing, args.now);
}
async function finishCompleted(ctx, args) {
    const { row, result } = args;
    const now = ctx.clock();
    const decorated = (0, helpers_1.decorateResult)(result, { jobRunId: row.id, attempts: row.attempts });
    await ctx.store.update(row.id, {
        status: 'completed',
        finishedAt: now,
        lockExpiresAt: null,
        nextRunAt: null,
        error: null,
        metadataJson: decorated.metadata == null ? undefined : (0, helpers_1.toJson)(decorated.metadata),
        resultJson: (0, helpers_1.toJson)(decorated),
    });
    return decorated;
}
async function finishFailed(ctx, args) {
    const { row, err } = args;
    const now = ctx.clock();
    const message = err instanceof Error ? err.message : String(err);
    const deadLettered = row.attempts >= row.maxAttempts;
    const nextRunAt = deadLettered ? null : (0, helpers_1.addMs)(now, (0, helpers_1.backoffForAttempt)(row.attempts));
    await ctx.store.update(row.id, {
        status: deadLettered ? 'dead' : 'failed',
        error: message,
        finishedAt: now,
        lockExpiresAt: null,
        nextRunAt,
        resultJson: (0, helpers_1.toJson)({
            status: 'failed',
            error: message,
            metadata: { jobRunId: row.id, attempts: row.attempts, deadLettered },
        }),
    });
    return {
        status: 'failed',
        error: message,
        metadata: {
            jobRunId: row.id,
            attempts: row.attempts,
            deadLettered,
            nextRunAt: nextRunAt?.toISOString() ?? null,
        },
    };
}
async function runDurableJob(store, opts) {
    const { jobName, scheduledFor, handler, maxAttempts = exports.DEFAULT_MAX_ATTEMPTS, lockTimeoutMs = exports.LOCK_TIMEOUT_MS, handlerTimeoutMs = lockTimeoutMs, clock = () => new Date(), now = clock(), } = opts;
    const ctx = { store, lockTimeoutMs, clock };
    const scheduledForDate = (0, helpers_1.validScheduledFor)(scheduledFor, now);
    const key = (0, helpers_1.dedupeKey)(jobName, scheduledForDate);
    const claim = await claimRun(ctx, { jobName, key, scheduledFor: scheduledForDate, now, maxAttempts });
    if (claim.kind === 'short-circuit') {
        return claim.result;
    }
    const jobCtx = { scheduledFor: scheduledForDate.toISOString() };
    try {
        const result = await (0, helpers_1.runHandlerWithTimeout)(handler, jobCtx, handlerTimeoutMs);
        if (result.status === 'failed') {
            return await finishFailed(ctx, { row: claim.row, err: result.error ?? 'Job handler returned failed' });
        }
        return await finishCompleted(ctx, { row: claim.row, result });
    }
    catch (err) {
        (0, config_1.getLogger)().warn({ err, jobName, jobRunId: claim.row.id }, '[jobs] durable job attempt failed');
        return await finishFailed(ctx, { row: claim.row, err });
    }
}
