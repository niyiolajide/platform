export interface RunIsolatedOptions<TPayload> {
    /** Absolute path to the child entry module. It must call registerIsolatedHandler(). */
    entry: string;
    /** Serializable payload sent to the child over IPC (structured-clone via Node IPC). */
    payload: TPayload;
    /** Hard timeout. On expiry the child is killed and the call rejects. Default 300000. */
    timeoutMs?: number;
    /** Extra args for the child node process, e.g. ['--import','tsx'] to run a TS entry. */
    execArgv?: string[];
    /** Extra env merged over the parent env for the child. */
    env?: Record<string, string | undefined>;
    /** Grace between SIGTERM and SIGKILL when killing a hung/cancelled child. Default 5000. */
    killGraceMs?: number;
    /** Optional label for logs. Defaults to the entry basename. */
    label?: string;
}
/**
 * Run `entry` in a disposable child process, hand it `payload`, and resolve with the
 * value the child's handler returns. The child is always reaped: on success it exits
 * itself; on timeout or parent-side error it is SIGTERM'd then SIGKILL'd after the grace.
 *
 * Rejects if: the child exits before returning a result (crash), the handler throws
 * (the error is rehydrated parent-side), or the timeout elapses.
 */
export declare function runIsolated<TResult = unknown, TPayload = unknown>(opts: RunIsolatedOptions<TPayload>): Promise<TResult>;
/**
 * Child-side entrypoint. Call this at the top level of an `entry` module: it waits for
 * the parent's payload, runs `handler` exactly once, sends the result back, and exits so
 * all of this process's memory is reclaimed. Any throw is serialized back to the parent.
 */
export declare function registerIsolatedHandler<TPayload = unknown, TResult = unknown>(handler: (payload: TPayload) => TResult | Promise<TResult>): void;
