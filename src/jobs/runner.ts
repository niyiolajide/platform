// Durable-job runner — a storage-agnostic port of the RetirementPulse durable
// state machine (src/lib/jobs/durable.ts). `runDurableJob(store, opts)` claims
// exactly one active attempt per (jobName, scheduledFor) slot via a unique
// dedupeKey, short-circuits completed/dead/locked duplicates, reclaims expired
// locks with an optimistic CAS, retries with exponential backoff, and
// dead-letters after maxAttempts. Handlers additionally race a configurable
// wall-clock timeout (see helpers.runHandlerWithTimeout).

import { getLogger } from '../config'
import {
  addMs,
  backoffForAttempt,
  decorateResult,
  dedupeKey,
  retryable,
  runHandlerWithTimeout,
  storedResult,
  toJson,
  validScheduledFor,
} from './helpers'
import {
  isDedupeConflict,
  type JobContext,
  type JobRunRecord,
  type JobRunResult,
  type JobRunStore,
  type RunDurableJobOptions,
} from './types'

export const DEFAULT_MAX_ATTEMPTS = 3
export const LOCK_TIMEOUT_MS = 15 * 60 * 1000

interface Ctx {
  store: JobRunStore
  lockTimeoutMs: number
  clock: () => Date
}

type ClaimResult =
  | { kind: 'claimed'; row: JobRunRecord }
  | { kind: 'short-circuit'; result: JobRunResult }

function completedShortCircuit(row: JobRunRecord): ClaimResult {
  const result = storedResult(row) ?? { status: 'completed' as const, metadata: row.metadataJson ?? undefined }
  return {
    kind: 'short-circuit',
    result: decorateResult(result, { jobRunId: row.id, attempts: row.attempts, deduped: true }),
  }
}

async function deadShortCircuit(ctx: Ctx, row: JobRunRecord, now: Date): Promise<ClaimResult> {
  const dead = row.status === 'dead' ? row : await deadLetter(ctx, row, now)
  return {
    kind: 'short-circuit',
    result: {
      status: 'failed',
      error: dead.error ?? 'Job run is dead-lettered',
      metadata: { jobRunId: dead.id, attempts: dead.attempts, deadLettered: true },
    },
  }
}

function activeShortCircuit(row: JobRunRecord): ClaimResult {
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
  }
}

interface ClaimArgs {
  jobName: string
  key: string
  scheduledFor: Date
  now: Date
  maxAttempts: number
}

async function createRun(ctx: Ctx, args: ClaimArgs): Promise<JobRunRecord> {
  const { jobName, key, scheduledFor, now, maxAttempts } = args
  return await ctx.store.create({
    jobName,
    dedupeKey: key,
    scheduledFor,
    status: 'running',
    attempts: 1,
    maxAttempts,
    lockedAt: now,
    lockExpiresAt: addMs(now, ctx.lockTimeoutMs),
    startedAt: now,
  })
}

async function deadLetter(ctx: Ctx, row: JobRunRecord, now: Date): Promise<JobRunRecord> {
  return await ctx.store.update(row.id, {
    status: 'dead',
    finishedAt: now,
    lockExpiresAt: null,
    nextRunAt: null,
  })
}

async function retryClaim(ctx: Ctx, row: JobRunRecord, now: Date): Promise<ClaimResult> {
  // The guard pins {status, attempts}, so `attempts + 1` is the same atomic
  // increment the reference performed with Prisma's { increment: 1 }.
  const claimed = await ctx.store.updateWhere(
    { id: row.id, status: row.status, attempts: row.attempts },
    {
      status: 'running',
      attempts: row.attempts + 1,
      lockedAt: now,
      lockExpiresAt: addMs(now, ctx.lockTimeoutMs),
      startedAt: now,
      finishedAt: null,
      nextRunAt: null,
      error: null,
    },
  )

  if (claimed !== 1) {
    return {
      kind: 'short-circuit',
      result: {
        status: 'dispatched',
        metadata: { jobRunId: row.id, attempts: row.attempts, deduped: true, currentStatus: 'running' },
      },
    }
  }

  const updated = await ctx.store.findById(row.id)
  if (!updated) {throw new Error(`Claimed job run ${row.id} disappeared`)}
  return { kind: 'claimed', row: updated }
}

async function claimExisting(ctx: Ctx, row: JobRunRecord, now: Date): Promise<ClaimResult> {
  if (row.status === 'completed') {return completedShortCircuit(row)}
  if (row.status === 'dead' || (row.status === 'failed' && row.attempts >= row.maxAttempts)) {
    return await deadShortCircuit(ctx, row, now)
  }
  if (!retryable(row, now)) {return activeShortCircuit(row)}
  return await retryClaim(ctx, row, now)
}

async function claimRun(ctx: Ctx, args: ClaimArgs): Promise<ClaimResult> {
  try {
    return { kind: 'claimed', row: await createRun(ctx, args) }
  } catch (err) {
    if (!isDedupeConflict(err)) {throw err}
  }

  const existing = await ctx.store.findByDedupeKey(args.key)
  if (!existing) {return { kind: 'claimed', row: await createRun(ctx, args) }}
  return await claimExisting(ctx, existing, args.now)
}

async function finishCompleted(ctx: Ctx, args: { row: JobRunRecord; result: JobRunResult }): Promise<JobRunResult> {
  const { row, result } = args
  const now = ctx.clock()
  const decorated = decorateResult(result, { jobRunId: row.id, attempts: row.attempts })
  await ctx.store.update(row.id, {
    status: 'completed',
    finishedAt: now,
    lockExpiresAt: null,
    nextRunAt: null,
    error: null,
    metadataJson: decorated.metadata == null ? undefined : toJson(decorated.metadata),
    resultJson: toJson(decorated),
  })
  return decorated
}

async function finishFailed(ctx: Ctx, args: { row: JobRunRecord; err: unknown }): Promise<JobRunResult> {
  const { row, err } = args
  const now = ctx.clock()
  const message = err instanceof Error ? err.message : String(err)
  const deadLettered = row.attempts >= row.maxAttempts
  const nextRunAt = deadLettered ? null : addMs(now, backoffForAttempt(row.attempts))
  await ctx.store.update(row.id, {
    status: deadLettered ? 'dead' : 'failed',
    error: message,
    finishedAt: now,
    lockExpiresAt: null,
    nextRunAt,
    resultJson: toJson({
      status: 'failed',
      error: message,
      metadata: { jobRunId: row.id, attempts: row.attempts, deadLettered },
    }),
  })
  return {
    status: 'failed',
    error: message,
    metadata: {
      jobRunId: row.id,
      attempts: row.attempts,
      deadLettered,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    },
  }
}

export async function runDurableJob(store: JobRunStore, opts: RunDurableJobOptions): Promise<JobRunResult> {
  const {
    jobName,
    scheduledFor,
    handler,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    lockTimeoutMs = LOCK_TIMEOUT_MS,
    handlerTimeoutMs = lockTimeoutMs,
    clock = () => new Date(),
    now = clock(),
  } = opts
  const ctx: Ctx = { store, lockTimeoutMs, clock }
  const scheduledForDate = validScheduledFor(scheduledFor, now)
  const key = dedupeKey(jobName, scheduledForDate)
  const claim = await claimRun(ctx, { jobName, key, scheduledFor: scheduledForDate, now, maxAttempts })
  if (claim.kind === 'short-circuit') {return claim.result}

  const jobCtx: JobContext = { scheduledFor: scheduledForDate.toISOString() }
  try {
    const result = await runHandlerWithTimeout(handler, jobCtx, handlerTimeoutMs)
    if (result.status === 'failed') {
      return await finishFailed(ctx, { row: claim.row, err: result.error ?? 'Job handler returned failed' })
    }
    return await finishCompleted(ctx, { row: claim.row, result })
  } catch (err) {
    getLogger().warn({ err, jobName, jobRunId: claim.row.id }, '[jobs] durable job attempt failed')
    return await finishFailed(ctx, { row: claim.row, err })
  }
}
