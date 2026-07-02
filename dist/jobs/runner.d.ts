import { type JobRunResult, type JobRunStore, type RunDurableJobOptions } from './types';
export declare const DEFAULT_MAX_ATTEMPTS = 3;
export declare const LOCK_TIMEOUT_MS: number;
export declare function runDurableJob(store: JobRunStore, opts: RunDurableJobOptions): Promise<JobRunResult>;
