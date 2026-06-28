import { fork, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { getLogger, type PlatformLogger } from '../config'

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

const RESULT = '__isolate_result__'
const RUN = '__isolate_run__'
const READY = '__isolate_ready__'

interface RunMessage<TPayload> { type: typeof RUN; payload: TPayload }
interface ReadyMessage { type: typeof READY }
interface SerializedError { message: string; stack?: string; name?: string }
interface ResultFailureMessage { type: typeof RESULT; ok: false; error?: SerializedError }

type ResultMessage = { type: typeof RESULT; ok: true; result: unknown } | ResultFailureMessage
type Timer = ReturnType<typeof setTimeout>

interface ChildForkOptions { entry: string; execArgv: string[]; env?: Record<string, string | undefined> }
interface ParentTimers { timeout?: Timer; kill?: Timer }

interface ParentMessageContext {
  child: ChildProcess; finish: (fn: () => void) => void; killGraceMs: number; payload: unknown
  reject: (reason?: unknown) => void; resolve: (value: unknown) => void
}

interface TimeoutContext {
  finish: (fn: () => void) => void; label: string; log: PlatformLogger; reap: () => void
  reject: (reason?: unknown) => void; timeoutMs: number
}

export interface RunIsolatedOptions<TPayload> {
  /** Absolute path to the child entry module. It must call registerIsolatedHandler(). */
  entry: string
  /** Serializable payload sent to the child over IPC (structured-clone via Node IPC). */
  payload: TPayload
  /** Hard timeout. On expiry the child is killed and the call rejects. Default 300000. */
  timeoutMs?: number
  /** Extra args for the child node process, e.g. ['--import','tsx'] to run a TS entry. */
  execArgv?: string[]
  /** Extra env merged over the parent env for the child. */
  env?: Record<string, string | undefined>
  /** Grace between SIGTERM and SIGKILL when killing a hung/cancelled child. Default 5000. */
  killGraceMs?: number
  /** Optional label for logs. Defaults to the entry basename. */
  label?: string
}

function defaultLabel(entry: string): string {
  const name = basename(entry)
  return name === '' ? 'isolated' : name
}

function forkIsolatedChild({ entry, execArgv, env }: ChildForkOptions): ChildProcess {
  return fork(entry, [], {
    execArgv,
    env: { ...process.env, ...env },
    // Inherit stdio so the child's logs surface in the worker's log stream; keep IPC.
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    // Structured-clone IPC (not the JSON default): the handler's result and the payload
    // may carry Date/BigInt/Map/TypedArray. JSON would throw on BigInt and silently
    // stringify Dates — a footgun for a generic primitive consumers return rich data from.
    serialization: 'advanced',
  })
}

function clearTimer(timer: Timer | undefined): void {
  if (timer !== undefined) { clearTimeout(timer) }
}

function makeFinish(timers: ParentTimers): (fn: () => void) => void {
  let settled = false
  return (fn) => {
    if (settled) { return }
    settled = true
    clearTimer(timers.timeout)
    clearTimer(timers.kill)
    fn()
  }
}

/** SIGTERM, then SIGKILL after the grace if it's still alive. */
function reapChild(child: ChildProcess, killGraceMs: number): Timer | undefined {
  if (child.exitCode !== null || child.signalCode !== null) { return undefined }
  child.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL') }
  }, killGraceMs)
  killTimer.unref()
  return killTimer
}

function rememberReapTimer(timers: ParentTimers, child: ChildProcess, killGraceMs: number): void {
  const timer = reapChild(child, killGraceMs)
  if (timer !== undefined) { timers.kill = timer }
}

function timeoutError(label: string, timeoutMs: number): Error {
  return new Error(`isolated job "${label}" timed out after ${timeoutMs}ms`)
}

function exitedBeforeResultError(label: string, code: number | null, signal: NodeJS.Signals | null): Error {
  return new Error(`isolated job "${label}" exited before returning a result (code=${code}, signal=${signal})`)
}

function createTimeoutTimer({ finish, label, log, reap, reject, timeoutMs }: TimeoutContext): Timer {
  const timeout = setTimeout(() => {
    log.warn({ label, timeoutMs }, '[isolate] child timed out — killing')
    reap()
    finish(() => {
      reject(timeoutError(label, timeoutMs))
    })
  }, timeoutMs)
  timeout.unref()
  return timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return isRecord(value) && value.type === READY
}

function isSerializedError(value: unknown): value is SerializedError {
  if (!isRecord(value) || typeof value.message !== 'string') { return false }
  return (value.stack === undefined || typeof value.stack === 'string')
    && (value.name === undefined || typeof value.name === 'string')
}

function isResultMessage(value: unknown): value is ResultMessage {
  if (!isRecord(value) || value.type !== RESULT || typeof value.ok !== 'boolean') { return false }
  if (value.ok) { return true }
  return value.error === undefined || isSerializedError(value.error)
}

function isRunMessage(value: unknown): value is RunMessage<unknown> {
  return isRecord(value) && value.type === RUN
}

function sendRunMessage(child: ChildProcess, payload: unknown): void {
  const runMsg: RunMessage<unknown> = { type: RUN, payload }
  child.send(runMsg)
}

function errorFromResult(message: ResultFailureMessage): Error {
  const details = message.error
  const err = new Error(details?.message ?? 'isolated job failed')
  err.name = details?.name ?? 'IsolatedJobError'
  if (details?.stack !== undefined) {
    err.stack = details.stack
  }
  return err
}

function nudgeSettledChild(child: ChildProcess, killGraceMs: number): void {
  const killTimer = reapChild(child, killGraceMs)
  child.once('exit', () => { clearTimer(killTimer) })
}

function handleParentMessage(raw: unknown, context: ParentMessageContext): void {
  if (isReadyMessage(raw)) {
    sendRunMessage(context.child, context.payload)
    return
  }
  if (!isResultMessage(raw)) { return }
  if (raw.ok) {
    context.finish(() => { context.resolve(raw.result) })
  } else {
    context.finish(() => { context.reject(errorFromResult(raw)) })
  }
  // The child exits on its own after sending; nudge it if it lingers.
  nudgeSettledChild(context.child, context.killGraceMs)
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name }
  }
  return { message: String(error) }
}

/**
 * Run `entry` in a disposable child process, hand it `payload`, and resolve with the
 * value the child's handler returns. The child is always reaped: on success it exits
 * itself; on timeout or parent-side error it is SIGTERM'd then SIGKILL'd after the grace.
 *
 * Rejects if: the child exits before returning a result (crash), the handler throws
 * (the error is rehydrated parent-side), or the timeout elapses.
 */
export function runIsolated<TResult = unknown, TPayload = unknown>(
  opts: RunIsolatedOptions<TPayload>,
): Promise<TResult> {
  const {
    entry,
    payload,
    timeoutMs = 300_000,
    execArgv = [],
    env,
    killGraceMs = 5_000,
    label = defaultLabel(entry),
  } = opts
  const log = getLogger()

  return new Promise<TResult>((resolve, reject) => {
    const child = forkIsolatedChild({ entry, execArgv, env })
    const timers: ParentTimers = {}
    const finish = makeFinish(timers)
    const reap = () => {
      rememberReapTimer(timers, child, killGraceMs)
    }
    const context: ParentMessageContext = {
      child,
      finish,
      killGraceMs,
      payload,
      reject,
      resolve: (value) => {
        resolve(value as TResult)
      },
    }

    timers.timeout = createTimeoutTimer({ finish, label, log, reap, reject, timeoutMs })

    child.on('message', (raw: unknown) => {
      handleParentMessage(raw, context)
    })

    child.on('error', (err) => {
      finish(() => { reject(err) })
    })

    child.on('exit', (code, signal) => {
      // If we already have a result this is the expected clean exit. Otherwise the
      // child died before returning — surface it as a failure.
      finish(() => { reject(exitedBeforeResultError(label, code, signal)) })
    })
  })
}

/**
 * Child-side entrypoint. Call this at the top level of an `entry` module: it waits for
 * the parent's payload, runs `handler` exactly once, sends the result back, and exits so
 * all of this process's memory is reclaimed. Any throw is serialized back to the parent.
 */
export function registerIsolatedHandler<TPayload = unknown, TResult = unknown>(
  handler: ((payload: TPayload) => TResult | Promise<TResult>) & {
    readonly __payloadType?: TPayload
  },
): void {
  if (!process.send) {
    throw new Error(
      'registerIsolatedHandler() must run in a process forked by runIsolated() (no IPC channel found)',
    )
  }
  const send = process.send.bind(process)

  const exitAfter = (msg: ResultMessage) => {
    // Flush the IPC message, then exit. Force-exit shortly after as a backstop in case
    // a stray handle (Chromium subprocess, open socket) would otherwise keep us alive.
    send(msg, () => {
      const t = setTimeout(() => { process.exit(msg.ok ? 0 : 1) }, 250)
      t.unref()
      process.exit(msg.ok ? 0 : 1)
    })
  }

  const runHandler = async (message: RunMessage<unknown>) => {
    try {
      const result = await handler(message.payload as TPayload)
      exitAfter({ type: RESULT, ok: true, result })
    } catch (error: unknown) {
      exitAfter({ type: RESULT, ok: false, error: serializeError(error) })
    }
  }

  process.once('message', (raw: unknown) => {
    if (!isRunMessage(raw)) { return }
    void runHandler(raw)
  })

  // Signal readiness so the parent sends the payload only once we're listening.
  send({ type: READY })
}
