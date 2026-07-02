// Ported from RetirementPulse src/__tests__/unit/jobs.durable.test.ts, driven
// through the storage-agnostic JobRunStore port with an in-memory fake, plus
// new coverage: expired-lock reclaim, handler timeout, timeout reclaim,
// concurrent CAS race, dead-row short-circuit, and backoff-not-due dispatch.
import { beforeEach, expect, it, vi } from 'vitest'
import { configurePlatform } from '../src/config'
import {
  DedupeConflictError,
  runDurableJob,
  type JobRunCreate,
  type JobRunGuard,
  type JobRunRecord,
  type JobRunStore,
  type JobRunUpdate,
} from '../src/jobs'

const rows = new Map<string, JobRunRecord>()
const seq = { value: 0 }
const logWarn = vi.fn()

function rowById(id: string): JobRunRecord | null {
  return [...rows.values()].find((stored) => stored.id === id) ?? null
}

function applyPatch(row: JobRunRecord, patch: JobRunUpdate) {
  const target = row as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {continue}
    target[key] = value
  }
  row.updatedAt = new Date()
}

const store: JobRunStore = {
  async create(data: JobRunCreate) {
    if (rows.has(data.dedupeKey)) {throw new DedupeConflictError(data.dedupeKey)}
    const next: JobRunRecord = {
      ...data,
      id: `run_${++seq.value}`,
      finishedAt: null,
      nextRunAt: null,
      resultJson: null,
      metadataJson: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    rows.set(next.dedupeKey, next)
    return { ...next }
  },
  async findByDedupeKey(dedupeKey: string) {
    const stored = rows.get(dedupeKey)
    return stored ? { ...stored } : null
  },
  async findById(id: string) {
    const stored = rowById(id)
    return stored ? { ...stored } : null
  },
  async update(id: string, patch: JobRunUpdate) {
    const stored = rowById(id)
    if (!stored) {throw new Error(`missing row ${id}`)}
    applyPatch(stored, patch)
    return { ...stored }
  },
  async updateWhere(guard: JobRunGuard, patch: JobRunUpdate) {
    const stored = rowById(guard.id)
    if (!stored || stored.status !== guard.status || stored.attempts !== guard.attempts) {return 0}
    applyPatch(stored, patch)
    return 1
  },
}

const NOW = new Date('2026-06-30T09:00:00.000Z')
const SCHEDULED_FOR = '2026-06-30T12:00:00.000Z'
const KEY = `sync-cross-app:${SCHEDULED_FOR}`

function row(overrides: Partial<JobRunRecord>): JobRunRecord {
  return {
    id: 'run_existing',
    jobName: 'sync-cross-app',
    dedupeKey: KEY,
    scheduledFor: new Date(SCHEDULED_FOR),
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    lockedAt: NOW,
    lockExpiresAt: new Date('2026-06-30T09:15:00.000Z'),
    startedAt: NOW,
    finishedAt: null,
    nextRunAt: null,
    resultJson: null,
    metadataJson: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  rows.clear()
  seq.value = 0
  logWarn.mockReset()
  configurePlatform({ logger: { warn: logWarn, info: vi.fn(), error: vi.fn() } })
})

it('creates a durable run and stores a completed result with run metadata', async () => {
  const handler = vi.fn().mockResolvedValue({ status: 'completed', metadata: { users: 1 } })

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).toHaveBeenCalledWith({ scheduledFor: SCHEDULED_FOR })
  expect(result).toEqual({ status: 'completed', metadata: { users: 1, jobRunId: 'run_1', attempts: 1 } })
  const stored = rows.get(KEY)
  expect(stored).toMatchObject({
    status: 'completed',
    attempts: 1,
    lockExpiresAt: null,
    resultJson: { status: 'completed', metadata: { users: 1, jobRunId: 'run_1', attempts: 1 } },
  })
})

it('dedupes an already completed scheduled run without calling the handler', async () => {
  rows.set(KEY, row({
    status: 'completed',
    attempts: 1,
    finishedAt: NOW,
    resultJson: { status: 'completed', metadata: { users: 2, jobRunId: 'run_existing', attempts: 1 } },
  }))
  const handler = vi.fn()

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).not.toHaveBeenCalled()
  expect(result).toEqual({
    status: 'completed',
    metadata: { users: 2, jobRunId: 'run_existing', attempts: 1, deduped: true },
  })
})

it('returns dispatched for a duplicate while the existing lock is active', async () => {
  rows.set(KEY, row({ status: 'running', lockExpiresAt: new Date('2026-06-30T09:05:00.000Z') }))
  const handler = vi.fn()

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).not.toHaveBeenCalled()
  expect(result).toEqual({
    status: 'dispatched',
    metadata: {
      jobRunId: 'run_existing',
      attempts: 1,
      deduped: true,
      currentStatus: 'running',
      nextRunAt: null,
    },
  })
})

it('returns dispatched for a failed run whose backoff is not yet due', async () => {
  rows.set(KEY, row({
    status: 'failed',
    lockExpiresAt: null,
    nextRunAt: new Date('2026-06-30T09:30:00.000Z'),
  }))
  const handler = vi.fn()

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    status: 'dispatched',
    metadata: { deduped: true, currentStatus: 'failed', nextRunAt: '2026-06-30T09:30:00.000Z' },
  })
})

it('retries an eligible failed run and dead-letters when max attempts are exhausted', async () => {
  rows.set(KEY, row({
    status: 'failed',
    attempts: 1,
    maxAttempts: 2,
    lockExpiresAt: null,
    nextRunAt: new Date('2026-06-30T08:55:00.000Z'),
  }))
  const handler = vi.fn().mockRejectedValue(new Error('sibling timeout'))

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).toHaveBeenCalledWith({ scheduledFor: SCHEDULED_FOR })
  expect(result).toEqual({
    status: 'failed',
    error: 'sibling timeout',
    metadata: { jobRunId: 'run_existing', attempts: 2, deadLettered: true, nextRunAt: null },
  })
  expect(rows.get(KEY)).toMatchObject({ status: 'dead', attempts: 2, error: 'sibling timeout' })
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({ jobName: 'sync-cross-app', jobRunId: 'run_existing' }),
    '[jobs] durable job attempt failed',
  )
})

it('short-circuits an already dead-lettered run without calling the handler', async () => {
  rows.set(KEY, row({ status: 'dead', attempts: 3, lockExpiresAt: null, error: 'gave up' }))
  const handler = vi.fn()

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).not.toHaveBeenCalled()
  expect(result).toEqual({
    status: 'failed',
    error: 'gave up',
    metadata: { jobRunId: 'run_existing', attempts: 3, deadLettered: true },
  })
})

it('reclaims a running row whose lock has expired via the CAS guard', async () => {
  rows.set(KEY, row({ status: 'running', attempts: 1, lockExpiresAt: new Date('2026-06-30T08:45:00.000Z') }))
  const handler = vi.fn().mockResolvedValue({ status: 'completed', metadata: { users: 3 } })

  const result = await runDurableJob(store, { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW })

  expect(handler).toHaveBeenCalledWith({ scheduledFor: SCHEDULED_FOR })
  expect(result).toEqual({ status: 'completed', metadata: { users: 3, jobRunId: 'run_existing', attempts: 2 } })
  expect(rows.get(KEY)).toMatchObject({ status: 'completed', attempts: 2, lockExpiresAt: null })
})

it('lets exactly one of two concurrent dispatches reclaim an eligible run', async () => {
  rows.set(KEY, row({
    status: 'failed',
    attempts: 1,
    lockExpiresAt: null,
    nextRunAt: new Date('2026-06-30T08:55:00.000Z'),
  }))
  const handler = vi.fn().mockResolvedValue({ status: 'completed' })
  const opts = { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler, now: NOW }

  const [a, b] = await Promise.all([runDurableJob(store, opts), runDurableJob(store, opts)])

  expect(handler).toHaveBeenCalledTimes(1)
  expect([a.status, b.status].sort()).toEqual(['completed', 'dispatched'])
  expect(rows.get(KEY)).toMatchObject({ status: 'completed', attempts: 2 })
})

it('marks a timed-out handler failed with handler_timeout, clears the lock, and schedules backoff', async () => {
  const handler = vi.fn().mockImplementation(() => new Promise(() => undefined))

  const result = await runDurableJob(store, {
    jobName: 'sync-cross-app',
    scheduledFor: SCHEDULED_FOR,
    handler,
    now: NOW,
    clock: () => NOW,
    handlerTimeoutMs: 20,
  })

  expect(result).toEqual({
    status: 'failed',
    error: 'handler_timeout',
    metadata: { jobRunId: 'run_1', attempts: 1, deadLettered: false, nextRunAt: '2026-06-30T09:05:00.000Z' },
  })
  expect(rows.get(KEY)).toMatchObject({
    status: 'failed',
    attempts: 1,
    error: 'handler_timeout',
    lockExpiresAt: null,
    nextRunAt: new Date('2026-06-30T09:05:00.000Z'),
  })
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({ jobName: 'sync-cross-app', jobRunId: 'run_1' }),
    '[jobs] durable job attempt failed',
  )
})

it('allows a later dispatch to reclaim a timed-out run once backoff has elapsed', async () => {
  const stuck = vi.fn().mockImplementation(() => new Promise(() => undefined))
  await runDurableJob(store, {
    jobName: 'sync-cross-app',
    scheduledFor: SCHEDULED_FOR,
    handler: stuck,
    now: NOW,
    clock: () => NOW,
    handlerTimeoutMs: 20,
  })
  expect(rows.get(KEY)).toMatchObject({ status: 'failed', attempts: 1, error: 'handler_timeout' })

  const later = new Date('2026-06-30T09:06:00.000Z')
  const handler = vi.fn().mockResolvedValue({ status: 'completed', metadata: { users: 5 } })
  const result = await runDurableJob(store, {
    jobName: 'sync-cross-app',
    scheduledFor: SCHEDULED_FOR,
    handler,
    now: later,
    clock: () => later,
  })

  expect(handler).toHaveBeenCalledWith({ scheduledFor: SCHEDULED_FOR })
  expect(result).toEqual({ status: 'completed', metadata: { users: 5, jobRunId: 'run_1', attempts: 2 } })
  expect(rows.get(KEY)).toMatchObject({ status: 'completed', attempts: 2, error: null, nextRunAt: null })
})

it('dead-letters after maxAttempts and short-circuits every dispatch afterwards', async () => {
  const failing = vi.fn().mockRejectedValue(new Error('still broken'))
  const base = { jobName: 'sync-cross-app', scheduledFor: SCHEDULED_FOR, handler: failing, maxAttempts: 2, clock: () => NOW }

  const first = await runDurableJob(store, { ...base, now: NOW })
  expect(first).toMatchObject({ status: 'failed', metadata: { attempts: 1, deadLettered: false } })

  const second = await runDurableJob(store, { ...base, now: new Date('2026-06-30T09:10:00.000Z') })
  expect(second).toMatchObject({ status: 'failed', metadata: { attempts: 2, deadLettered: true } })
  expect(rows.get(KEY)).toMatchObject({ status: 'dead', attempts: 2 })

  const third = await runDurableJob(store, { ...base, now: new Date('2026-06-30T10:00:00.000Z') })
  expect(failing).toHaveBeenCalledTimes(2)
  expect(third).toEqual({
    status: 'failed',
    error: 'still broken',
    metadata: { jobRunId: 'run_1', attempts: 2, deadLettered: true },
  })
})
