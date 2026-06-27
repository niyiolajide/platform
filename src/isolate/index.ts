import { fork, type ChildProcess } from 'node:child_process'
import { getLogger } from '../config'

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

interface RunMessage<TPayload> {
  type: typeof RUN
  payload: TPayload
}
interface ResultMessage {
  type: typeof RESULT
  ok: boolean
  result?: unknown
  error?: { message: string; stack?: string; name?: string }
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
    label = entry.split('/').pop() || 'isolated',
  } = opts
  const log = getLogger()

  return new Promise<TResult>((resolve, reject) => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const child: ChildProcess = fork(entry, [], {
      execArgv,
      env: { ...process.env, ...env },
      // Inherit stdio so the child's logs surface in the worker's log stream; keep IPC.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    })

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
    }

    /** SIGTERM, then SIGKILL after the grace if it's still alive. */
    const reap = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, killGraceMs)
      killTimer.unref?.()
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    timeoutTimer = setTimeout(() => {
      log.warn?.({ label, timeoutMs }, '[isolate] child timed out — killing')
      reap()
      finish(() => reject(new Error(`isolated job "${label}" timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    timeoutTimer.unref?.()

    child.on('message', (msg: ResultMessage | { type: typeof READY }) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === READY) {
        const runMsg: RunMessage<TPayload> = { type: RUN, payload }
        child.send(runMsg)
        return
      }
      if (msg.type === RESULT) {
        const r = msg as ResultMessage
        if (r.ok) {
          finish(() => resolve(r.result as TResult))
        } else {
          const e = new Error(r.error?.message || 'isolated job failed')
          e.name = r.error?.name || 'IsolatedJobError'
          if (r.error?.stack) e.stack = r.error.stack
          finish(() => reject(e))
        }
        // The child exits on its own after sending; nudge it if it lingers.
        reap()
      }
    })

    child.on('error', (err) => {
      finish(() => reject(err))
    })

    child.on('exit', (code, signal) => {
      // If we already have a result this is the expected clean exit. Otherwise the
      // child died before returning — surface it as a failure.
      finish(() =>
        reject(
          new Error(
            `isolated job "${label}" exited before returning a result (code=${code}, signal=${signal})`,
          ),
        ),
      )
    })
  })
}

/**
 * Child-side entrypoint. Call this at the top level of an `entry` module: it waits for
 * the parent's payload, runs `handler` exactly once, sends the result back, and exits so
 * all of this process's memory is reclaimed. Any throw is serialized back to the parent.
 */
export function registerIsolatedHandler<TPayload = unknown, TResult = unknown>(
  handler: (payload: TPayload) => TResult | Promise<TResult>,
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
      const t = setTimeout(() => process.exit(msg.ok ? 0 : 1), 250)
      t.unref?.()
      process.exit(msg.ok ? 0 : 1)
    })
  }

  process.once('message', async (raw: RunMessage<TPayload>) => {
    if (!raw || raw.type !== RUN) return
    try {
      const result = await handler(raw.payload)
      exitAfter({ type: RESULT, ok: true, result })
    } catch (err: any) {
      exitAfter({
        type: RESULT,
        ok: false,
        error: { message: String(err?.message ?? err), stack: err?.stack, name: err?.name },
      })
    }
  })

  // Signal readiness so the parent sends the payload only once we're listening.
  send({ type: READY })
}
