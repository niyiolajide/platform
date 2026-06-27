"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runIsolated = runIsolated;
exports.registerIsolatedHandler = registerIsolatedHandler;
const node_child_process_1 = require("node:child_process");
const config_1 = require("../config");
// ── Process isolation for heavy jobs ───────────────────────────────────────────
// Run a heavy, memory-hungry job (Chromium/Stagehand scrape, ML inference, PDF
// render) in a SHORT-LIVED child process that exits when done. The kernel reclaims
// 100% of the child's native memory on exit — so a long-lived worker never retains
// the high-water mark of its heaviest job. This is the only reliable fix for native
// memory that the in-process GC / malloc tuning cannot release (e.g. Playwright's
// Chromium working set). Generic on purpose: the browser-ness is incidental.
//
// Parent:  await runIsolated({ entry, payload })            → child's result
// Child:   registerIsolatedHandler(async (payload) => out)  → runs once, then exits
const RESULT = '__isolate_result__';
const RUN = '__isolate_run__';
const READY = '__isolate_ready__';
/**
 * Run `entry` in a disposable child process, hand it `payload`, and resolve with the
 * value the child's handler returns. The child is always reaped: on success it exits
 * itself; on timeout or parent-side error it is SIGTERM'd then SIGKILL'd after the grace.
 *
 * Rejects if: the child exits before returning a result (crash), the handler throws
 * (the error is rehydrated parent-side), or the timeout elapses.
 */
function runIsolated(opts) {
    const { entry, payload, timeoutMs = 300000, execArgv = [], env, killGraceMs = 5000, label = entry.split('/').pop() || 'isolated', } = opts;
    const log = (0, config_1.getLogger)();
    return new Promise((resolve, reject) => {
        let settled = false;
        let killTimer;
        let timeoutTimer;
        const child = (0, node_child_process_1.fork)(entry, [], {
            execArgv,
            env: { ...process.env, ...env },
            // Inherit stdio so the child's logs surface in the worker's log stream; keep IPC.
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            // Structured-clone IPC (not the JSON default): the handler's result and the payload
            // may carry Date/BigInt/Map/TypedArray. JSON would throw on BigInt and silently
            // stringify Dates — a footgun for a generic primitive consumers return rich data from.
            serialization: 'advanced',
        });
        const cleanup = () => {
            if (timeoutTimer)
                clearTimeout(timeoutTimer);
            if (killTimer)
                clearTimeout(killTimer);
        };
        /** SIGTERM, then SIGKILL after the grace if it's still alive. */
        const reap = () => {
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill('SIGKILL');
            }, killGraceMs);
            killTimer.unref?.();
        };
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            fn();
        };
        timeoutTimer = setTimeout(() => {
            log.warn?.({ label, timeoutMs }, '[isolate] child timed out — killing');
            reap();
            finish(() => reject(new Error(`isolated job "${label}" timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
        timeoutTimer.unref?.();
        child.on('message', (msg) => {
            if (!msg || typeof msg !== 'object')
                return;
            if (msg.type === READY) {
                const runMsg = { type: RUN, payload };
                child.send(runMsg);
                return;
            }
            if (msg.type === RESULT) {
                const r = msg;
                if (r.ok) {
                    finish(() => resolve(r.result));
                }
                else {
                    const e = new Error(r.error?.message || 'isolated job failed');
                    e.name = r.error?.name || 'IsolatedJobError';
                    if (r.error?.stack)
                        e.stack = r.error.stack;
                    finish(() => reject(e));
                }
                // The child exits on its own after sending; nudge it if it lingers.
                reap();
            }
        });
        child.on('error', (err) => {
            finish(() => reject(err));
        });
        child.on('exit', (code, signal) => {
            // If we already have a result this is the expected clean exit. Otherwise the
            // child died before returning — surface it as a failure.
            finish(() => reject(new Error(`isolated job "${label}" exited before returning a result (code=${code}, signal=${signal})`)));
        });
    });
}
/**
 * Child-side entrypoint. Call this at the top level of an `entry` module: it waits for
 * the parent's payload, runs `handler` exactly once, sends the result back, and exits so
 * all of this process's memory is reclaimed. Any throw is serialized back to the parent.
 */
function registerIsolatedHandler(handler) {
    if (!process.send) {
        throw new Error('registerIsolatedHandler() must run in a process forked by runIsolated() (no IPC channel found)');
    }
    const send = process.send.bind(process);
    const exitAfter = (msg) => {
        // Flush the IPC message, then exit. Force-exit shortly after as a backstop in case
        // a stray handle (Chromium subprocess, open socket) would otherwise keep us alive.
        send(msg, () => {
            const t = setTimeout(() => process.exit(msg.ok ? 0 : 1), 250);
            t.unref?.();
            process.exit(msg.ok ? 0 : 1);
        });
    };
    process.once('message', async (raw) => {
        if (!raw || raw.type !== RUN)
            return;
        try {
            const result = await handler(raw.payload);
            exitAfter({ type: RESULT, ok: true, result });
        }
        catch (err) {
            exitAfter({
                type: RESULT,
                ok: false,
                error: { message: String(err?.message ?? err), stack: err?.stack, name: err?.name },
            });
        }
    });
    // Signal readiness so the parent sends the payload only once we're listening.
    send({ type: READY });
}
