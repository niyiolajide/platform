import type { JobContext, JobHandler, JobRunRecord, JobRunResult, JsonValue } from './types';
export declare const BASE_BACKOFF_MS: number;
export declare const MAX_BACKOFF_MS: number;
/** Error message stored on runs whose handler exceeded handlerTimeoutMs. */
export declare const HANDLER_TIMEOUT_ERROR = "handler_timeout";
export declare const toJson: (value: unknown) => JsonValue;
export declare function validScheduledFor(value: string, now: Date): Date;
export declare function dedupeKey(jobName: string, scheduledFor: Date): string;
export declare function addMs(date: Date, ms: number): Date;
/** Exponential backoff: 5m, 10m, 20m, 40m, capped at 60m. */
export declare function backoffForAttempt(attempt: number): number;
export declare function decorateResult(result: JobRunResult, metadata: Record<string, unknown>): JobRunResult;
export declare function storedResult(row: JobRunRecord): JobRunResult | null;
/** A run may be (re)claimed when queued, past its lock expiry, or past its retry backoff. */
export declare function retryable(row: JobRunRecord, now: Date): boolean;
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
export declare function runHandlerWithTimeout(handler: JobHandler, ctx: JobContext, timeoutMs: number): Promise<JobRunResult>;
