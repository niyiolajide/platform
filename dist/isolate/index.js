"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runIsolated = runIsolated;
exports.registerIsolatedHandler = registerIsolatedHandler;
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
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
function defaultLabel(entry) {
    const name = (0, node_path_1.basename)(entry);
    return name === '' ? 'isolated' : name;
}
function forkIsolatedChild({ entry, execArgv, env }) {
    return (0, node_child_process_1.fork)(entry, [], {
        execArgv,
        env: { ...process.env, ...env },
        // Inherit stdio so the child's logs surface in the worker's log stream; keep IPC.
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        // Structured-clone IPC (not the JSON default): the handler's result and the payload
        // may carry Date/BigInt/Map/TypedArray. JSON would throw on BigInt and silently
        // stringify Dates — a footgun for a generic primitive consumers return rich data from.
        serialization: 'advanced',
    });
}
function clearTimer(timer) {
    if (timer !== undefined) {
        clearTimeout(timer);
    }
}
function makeFinish(timers) {
    let settled = false;
    return (fn) => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimer(timers.timeout);
        clearTimer(timers.kill);
        fn();
    };
}
/** SIGTERM, then SIGKILL after the grace if it's still alive. */
function reapChild(child, killGraceMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return undefined;
    }
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    }, killGraceMs);
    killTimer.unref();
    return killTimer;
}
function rememberReapTimer(timers, child, killGraceMs) {
    const timer = reapChild(child, killGraceMs);
    if (timer !== undefined) {
        timers.kill = timer;
    }
}
function timeoutError(label, timeoutMs) {
    return new Error(`isolated job "${label}" timed out after ${timeoutMs}ms`);
}
function exitedBeforeResultError(label, code, signal) {
    return new Error(`isolated job "${label}" exited before returning a result (code=${code}, signal=${signal})`);
}
function createTimeoutTimer({ finish, label, log, reap, reject, timeoutMs }) {
    const timeout = setTimeout(() => {
        log.warn({ label, timeoutMs }, '[isolate] child timed out — killing');
        reap();
        finish(() => {
            reject(timeoutError(label, timeoutMs));
        });
    }, timeoutMs);
    timeout.unref();
    return timeout;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isReadyMessage(value) {
    return isRecord(value) && value.type === READY;
}
function isSerializedError(value) {
    if (!isRecord(value) || typeof value.message !== 'string') {
        return false;
    }
    return (value.stack === undefined || typeof value.stack === 'string')
        && (value.name === undefined || typeof value.name === 'string');
}
function isResultMessage(value) {
    if (!isRecord(value) || value.type !== RESULT || typeof value.ok !== 'boolean') {
        return false;
    }
    if (value.ok) {
        return true;
    }
    return value.error === undefined || isSerializedError(value.error);
}
function isRunMessage(value) {
    return isRecord(value) && value.type === RUN;
}
function sendRunMessage(child, payload) {
    const runMsg = { type: RUN, payload };
    child.send(runMsg);
}
function errorFromResult(message) {
    const details = message.error;
    const err = new Error(details?.message ?? 'isolated job failed');
    err.name = details?.name ?? 'IsolatedJobError';
    if (details?.stack !== undefined) {
        err.stack = details.stack;
    }
    return err;
}
function nudgeSettledChild(child, killGraceMs) {
    const killTimer = reapChild(child, killGraceMs);
    child.once('exit', () => { clearTimer(killTimer); });
}
function handleParentMessage(raw, context) {
    if (isReadyMessage(raw)) {
        sendRunMessage(context.child, context.payload);
        return;
    }
    if (!isResultMessage(raw)) {
        return;
    }
    if (raw.ok) {
        context.finish(() => { context.resolve(raw.result); });
    }
    else {
        context.finish(() => { context.reject(errorFromResult(raw)); });
    }
    // The child exits on its own after sending; nudge it if it lingers.
    nudgeSettledChild(context.child, context.killGraceMs);
}
function serializeError(error) {
    if (error instanceof Error) {
        return { message: error.message, stack: error.stack, name: error.name };
    }
    return { message: String(error) };
}
/**
 * Run `entry` in a disposable child process, hand it `payload`, and resolve with the
 * value the child's handler returns. The child is always reaped: on success it exits
 * itself; on timeout or parent-side error it is SIGTERM'd then SIGKILL'd after the grace.
 *
 * Rejects if: the child exits before returning a result (crash), the handler throws
 * (the error is rehydrated parent-side), or the timeout elapses.
 */
function runIsolated(opts) {
    const { entry, payload, timeoutMs = 300000, execArgv = [], env, killGraceMs = 5000, label = defaultLabel(entry), } = opts;
    const log = (0, config_1.getLogger)();
    return new Promise((resolve, reject) => {
        const child = forkIsolatedChild({ entry, execArgv, env });
        const timers = {};
        const finish = makeFinish(timers);
        const reap = () => {
            rememberReapTimer(timers, child, killGraceMs);
        };
        const context = {
            child,
            finish,
            killGraceMs,
            payload,
            reject,
            resolve: (value) => {
                resolve(value);
            },
        };
        timers.timeout = createTimeoutTimer({ finish, label, log, reap, reject, timeoutMs });
        child.on('message', (raw) => {
            handleParentMessage(raw, context);
        });
        child.on('error', (err) => {
            finish(() => { reject(err); });
        });
        child.on('exit', (code, signal) => {
            // If we already have a result this is the expected clean exit. Otherwise the
            // child died before returning — surface it as a failure.
            finish(() => { reject(exitedBeforeResultError(label, code, signal)); });
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
            const t = setTimeout(() => { process.exit(msg.ok ? 0 : 1); }, 250);
            t.unref();
            process.exit(msg.ok ? 0 : 1);
        });
    };
    const runHandler = async (message) => {
        try {
            const result = await handler(message.payload);
            exitAfter({ type: RESULT, ok: true, result });
        }
        catch (error) {
            exitAfter({ type: RESULT, ok: false, error: serializeError(error) });
        }
    };
    process.once('message', (raw) => {
        if (!isRunMessage(raw)) {
            return;
        }
        void runHandler(raw);
    });
    // Signal readiness so the parent sends the payload only once we're listening.
    send({ type: READY });
}
