// Durable-job envelope types. The runner is storage-agnostic: an app supplies a
// JobRunStore (typically a thin adapter over a `job_runs` table shaped like
// JobRunRecord — see the RetirementPulse Prisma `JobRun` model) and
// `runDurableJob` drives the claim/retry/dead-letter state machine on top of
// it. Plain JSON/Date types only — no @prisma/client dependency.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Lifecycle states of a durable run row. */
export type JobRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead'

/** One durable run row — mirrors the reference `job_runs` table columns. */
export interface JobRunRecord {
  id: string
  jobName: string
  /** Unique idempotency key: `${jobName}:${scheduledFor.toISOString()}`. */
  dedupeKey: string
  scheduledFor: Date
  status: JobRunStatus
  attempts: number
  maxAttempts: number
  lockedAt: Date | null
  lockExpiresAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  nextRunAt: Date | null
  resultJson: JsonValue | null
  metadataJson: JsonValue | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

/** Fields the runner supplies when inserting a fresh run row. */
export interface JobRunCreate {
  jobName: string
  dedupeKey: string
  scheduledFor: Date
  status: JobRunStatus
  attempts: number
  maxAttempts: number
  lockedAt: Date | null
  lockExpiresAt: Date | null
  startedAt: Date | null
}

/** Partial update; `undefined` means "leave unchanged", `null` means "clear". */
export interface JobRunUpdate {
  status?: JobRunStatus
  attempts?: number
  lockedAt?: Date | null
  lockExpiresAt?: Date | null
  startedAt?: Date | null
  finishedAt?: Date | null
  nextRunAt?: Date | null
  resultJson?: JsonValue
  metadataJson?: JsonValue
  error?: string | null
}

/** Optimistic-concurrency guard for `JobRunStore.updateWhere` claims. */
export interface JobRunGuard {
  id: string
  status: JobRunStatus
  attempts: number
}

export const DEDUPE_CONFLICT_CODE = 'DEDUPE_CONFLICT'

/** Store adapters throw this from `create` when the dedupeKey already exists. */
export class DedupeConflictError extends Error {
  readonly code = DEDUPE_CONFLICT_CODE
  constructor(dedupeKey?: string) {
    super(dedupeKey == null ? 'duplicate dedupe key' : `duplicate dedupe key ${dedupeKey}`)
    this.name = 'DedupeConflictError'
  }
}

/**
 * True for a DedupeConflictError or any error carrying a unique-violation code.
 * Prisma's raw P2002 is accepted so a naive adapter that forwards
 * `prisma.jobRun.create` errors unchanged still dedupes correctly.
 */
export function isDedupeConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err == null || !('code' in err)) {return false}
  const code = (err as { code?: unknown }).code
  return code === DEDUPE_CONFLICT_CODE || code === 'P2002'
}

/**
 * The minimal persistence port the runner needs. All methods operate on a
 * single table keyed by `id` with a unique index on `dedupeKey`.
 */
export interface JobRunStore {
  /** Insert a fresh row. MUST throw a dedupe conflict (see isDedupeConflict) when dedupeKey exists. */
  create(data: JobRunCreate): Promise<JobRunRecord>
  findByDedupeKey(dedupeKey: string): Promise<JobRunRecord | null>
  findById(id: string): Promise<JobRunRecord | null>
  /** Unconditional update by id; the row must exist. Returns the updated row. */
  update(id: string, patch: JobRunUpdate): Promise<JobRunRecord>
  /**
   * Compare-and-set: apply `patch` only where id AND status AND attempts still
   * match `guard`; returns the affected-row count (0 or 1). This is the
   * optimistic lock used to reclaim expired/failed runs exactly once.
   */
  updateWhere(guard: JobRunGuard, patch: JobRunUpdate): Promise<number>
}

/** Terminal (or dispatch) outcome reported to the caller / stored in resultJson. */
export type JobRunResultStatus = 'completed' | 'failed' | 'dispatched'

export interface JobRunResult {
  status: JobRunResultStatus
  metadata?: unknown
  error?: string
}

export interface JobContext {
  /** ISO timestamp of the scheduled slot this run represents. */
  scheduledFor: string
}

export type JobHandler = (ctx: JobContext) => Promise<JobRunResult>

export interface RunDurableJobOptions {
  jobName: string
  /** ISO timestamp of the scheduled slot; invalid strings fall back to `now`. */
  scheduledFor: string
  handler: JobHandler
  /** Attempts before dead-lettering. Default 3. */
  maxAttempts?: number
  /** How long a claimed lock is honoured before it may be reclaimed. Default 15 minutes. */
  lockTimeoutMs?: number
  /** Handler wall-clock budget (Promise.race). Defaults to lockTimeoutMs. */
  handlerTimeoutMs?: number
  /** Claim timestamp override for tests. Defaults to `clock()`. */
  now?: Date
  /** Clock used for finish/backoff timestamps. Defaults to `() => new Date()`. */
  clock?: () => Date
}
