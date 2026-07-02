// Pure helpers for the durable-job runner: dedupe keys, backoff math, result
// decoration, retry eligibility, and the handler timeout race. No storage here.

import type { JobContext, JobHandler, JobRunRecord, JobRunResult, JsonValue } from './types'

export const BASE_BACKOFF_MS = 5 * 60 * 1000
export const MAX_BACKOFF_MS = 60 * 60 * 1000

/** Error message stored on runs whose handler exceeded handlerTimeoutMs. */
export const HANDLER_TIMEOUT_ERROR = 'handler_timeout'

export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

export function validScheduledFor(value: string, now: Date): Date {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? now : date
}

export function dedupeKey(jobName: string, scheduledFor: Date): string {
  return `${jobName}:${scheduledFor.toISOString()}`
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms)
}

/** Exponential backoff: 5m, 10m, 20m, 40m, capped at 60m. */
export function backoffForAttempt(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS)
}

function objectMetadata(value: unknown): Record<string, unknown> {
  if (value == null) {return {}}
  if (typeof value === 'object' && !Array.isArray(value)) {return value as Record<string, unknown>}
  return { value }
}

export function decorateResult(result: JobRunResult, metadata: Record<string, unknown>): JobRunResult {
  return {
    ...result,
    metadata: {
      ...objectMetadata(result.metadata),
      ...metadata,
    },
  }
}

export function storedResult(row: JobRunRecord): JobRunResult | null {
  const value = row.resultJson as unknown
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {return null}
  const status = (value as { status?: unknown }).status
  if (status !== 'completed' && status !== 'failed' && status !== 'dispatched') {return null}
  return value as JobRunResult
}

/** A run may be (re)claimed when queued, past its lock expiry, or past its retry backoff. */
export function retryable(row: JobRunRecord, now: Date): boolean {
  if (row.status === 'running') {return row.lockExpiresAt == null || row.lockExpiresAt <= now}
  if (row.status === 'failed') {return row.nextRunAt == null || row.nextRunAt <= now}
  return row.status === 'queued'
}

class HandlerTimeoutError extends Error {
  constructor() {
    super(HANDLER_TIMEOUT_ERROR)
    this.name = 'HandlerTimeoutError'
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
export async function runHandlerWithTimeout(
  handler: JobHandler,
  ctx: JobContext,
  timeoutMs: number,
): Promise<JobRunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      handler(ctx),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new HandlerTimeoutError()) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer != null) {clearTimeout(timer)}
  }
}
