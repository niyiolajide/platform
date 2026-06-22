import { getLogger } from '../config'
import { readAiSettings } from '../control/store'
import type { CascadeStep, ProviderKind } from '../control/schema'
import { createAnonymizer, type Anonymizer } from './anonymize'
import { estimateCostCents } from './models'
import { ADAPTERS, getAdapter } from './registry'
import { hasAiTelemetrySink, recordAiCall, ulid, type AiCallRecord } from './telemetry'
import type { AttemptRequest, AttemptResult, StructuredAttempt, TokenUsage } from './types'

// ── Unified AI provider cascade ───────────────────────────────────────────────
// One ordered list of {provider, model} steps per tier (main/fast), walked top-to-
// bottom at CALL TIME: the first step whose provider is configured is tried; on any
// failure (API error, timeout, empty/refusal) the next step is tried; cross-provider
// failover is automatic. The public surface below (AiProvider / resolveAiProvider /
// generateStructured / generateText / modelName) is unchanged so call sites in the
// apps don't change — the returned object is just a thin facade over the cascade.

export type AiProviderKind = ProviderKind

/**
 * Optional, additive telemetry attribution carried on every AI request. Purely
 * metadata for the AiCallRecord — it never affects model selection or output, so
 * the public AiProvider API stays backward-compatible (all fields optional).
 */
export interface AiCallOpts {
  /** Originating app; defaults to env APP_NAME when omitted. */
  app?: string
  /** What this call is for (e.g. 'digest', 'classify-txn'). */
  purpose?: string
  /** End-user the call is made for, if any. */
  userId?: string | null
}

export interface StructuredRequest extends AiCallOpts {
  prompt: string
  system?: string
  toolName: string
  toolDescription: string
  jsonSchema: Record<string, unknown>
  maxTokens?: number
  model?: 'main' | 'fast'
}

export interface TextRequest extends AiCallOpts {
  prompt: string
  system?: string
  maxTokens?: number
  model?: 'main' | 'fast'
}

export interface AiProvider {
  kind: AiProviderKind
  label: string
  configured(): boolean
  modelName(which?: 'main' | 'fast'): string
  generateStructured(req: StructuredRequest): Promise<Record<string, unknown> | null>
  generateText(req: TextRequest): Promise<string | null>
}

type Tier = 'main' | 'fast'
type Kind = 'structured' | 'text'

// Per-attempt deadline so a hung call falls through to the next step. Ollama gets a
// wider budget for a possible cold model-load (mitigated by keep_alive pinning).
const TIMEOUT_MS: Record<ProviderKind, number> = {
  gemini: 60_000,
  anthropic: 60_000,
  ollama: 180_000,
}

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`attempt timed out after ${ms}ms`))
    }, ms)
    fn(ac.signal).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// Build the ordered, configured step list for a tier. An explicit `pref` provider
// is stably hoisted to the front; `only` restricts to a single provider (used by
// the historical single-provider `getProvider`).
function buildSteps(tier: Tier, pref?: string | null, only?: ProviderKind): CascadeStep[] {
  let steps = readAiSettings().cascades[tier].filter((s) => getAdapter(s.provider)?.configured())
  if (only) steps = steps.filter((s) => s.provider === only)
  if (pref) {
    const p = pref as ProviderKind
    steps = [...steps.filter((s) => s.provider === p), ...steps.filter((s) => s.provider !== p)]
  }
  return steps
}

async function runCascade(
  tier: Tier,
  kind: Kind,
  req: StructuredRequest | TextRequest,
  pref: string | null | undefined,
  onModel: (tier: Tier, model: string) => void,
  only?: ProviderKind,
): Promise<Record<string, unknown> | string | null> {
  const settings = readAiSettings()
  const steps = buildSteps(tier, pref, only)
  if (steps.length === 0) return null
  const logger = getLogger()

  // Telemetry is read live (mirrors anonymizeRequests). Only build records when a
  // sink is installed AND logging is on — otherwise the cascade is unchanged.
  const telemetryOn = settings.logAiCalls && hasAiTelemetrySink()
  const logPayloads = settings.logPayloads
  const app = (req as AiCallOpts).app || process.env.APP_NAME || 'unknown'
  const purpose = (req as AiCallOpts).purpose || 'unknown'
  const userId = (req as AiCallOpts).userId ?? null

  // Anonymize ONCE, reused across all cloud attempts. Local (Ollama) steps keep the
  // original text — data never leaves the LAN, so masking would only cost fidelity.
  const anon: Anonymizer | null = settings.anonymizeRequests ? createAnonymizer() : null
  const maskedPrompt = anon ? anon.mask(req.prompt) : req.prompt
  const maskedSystem = anon && req.system != null ? anon.mask(req.system) : req.system

  // Emit a record for this attempt. Best-effort: recordAiCall anonymizes the
  // payloads itself (idempotent) and never throws. We pass the masked prompt when
  // masking applied to this step, else the raw prompt (recordAiCall masks it anyway).
  const emit = (
    step: CascadeStep,
    attemptIdx: number,
    status: AiCallRecord['status'],
    ms: number,
    promptSent: string,
    responseText: string | null,
    usage: TokenUsage | undefined,
    error?: string,
  ) => {
    if (!telemetryOn) return
    const rec: AiCallRecord = {
      id: ulid(),
      ts: new Date().toISOString(),
      app,
      userId,
      purpose,
      caller: 'cascade',
      tier,
      provider: step.provider,
      model: step.model,
      attempt: attemptIdx,
      status,
      error: error ?? null,
      latencyMs: ms,
      ...(usage?.tokensIn != null ? { tokensIn: usage.tokensIn } : {}),
      ...(usage?.tokensOut != null ? { tokensOut: usage.tokensOut } : {}),
    }
    const cost = estimateCostCents(step.model, usage?.tokensIn, usage?.tokensOut)
    if (cost != null) rec.costCentsEst = cost
    if (logPayloads) {
      rec.prompt = promptSent
      if (responseText != null) rec.response = responseText
    }
    recordAiCall(rec)
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const adapter = getAdapter(step.provider)
    const useMask = anon != null && !adapter.local
    const willFallback = i < steps.length - 1
    const prompt = useMask ? maskedPrompt : req.prompt
    const system = useMask ? maskedSystem : req.system
    const startedAt = Date.now()
    try {
      const result = await withTimeout<AttemptResult<Record<string, unknown> | string>>((signal) => {
        if (kind === 'structured') {
          const r = req as StructuredRequest
          const attempt: StructuredAttempt = {
            prompt,
            system,
            maxTokens: r.maxTokens,
            toolName: r.toolName,
            toolDescription: r.toolDescription,
            jsonSchema: r.jsonSchema,
          }
          return adapter.callStructured(step.model, attempt, signal)
        }
        const attempt: AttemptRequest = { prompt, system, maxTokens: req.maxTokens }
        return adapter.callText(step.model, attempt, signal)
      }, TIMEOUT_MS[step.provider])

      const ms = Date.now() - startedAt
      const out = result.content
      if (out != null) {
        onModel(tier, step.model)
        logger.info(
          { tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms },
          '[ai/cascade] answered',
        )
        const restored =
          !useMask || !anon
            ? out
            : kind === 'structured'
              ? anon.unmaskDeep(out as Record<string, unknown>)
              : anon.unmask(out as string)
        // Log the response as text (stringify structured output). The masked prompt
        // that left the host (`prompt`) is what we record; recordAiCall masks again
        // (idempotent) for safety on the raw path.
        const responseText =
          typeof restored === 'string' ? restored : JSON.stringify(restored)
        emit(step, i + 1, 'ok', ms, prompt, responseText, result.usage)
        return restored
      }
      logger.warn(
        { tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms, reason: 'empty', willFallback },
        '[ai/cascade] empty response',
      )
      emit(step, i + 1, 'empty', ms, prompt, null, result.usage)
    } catch (err) {
      const ms = Date.now() - startedAt
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        { err, tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms, willFallback },
        '[ai/cascade] attempt failed',
      )
      emit(step, i + 1, 'error', ms, prompt, null, undefined, msg)
    }
  }
  logger.warn({ tier, kind, attempts: steps.length }, '[ai/cascade] all steps failed')
  return null
}

// ── Facade ────────────────────────────────────────────────────────────────────
// Implements the historical AiProvider surface over the cascade. `last` is scoped
// to THIS facade instance (one per resolveAiProvider call), so modelName() reports
// the model that actually answered — no shared global state.

function makeProvider(pref: string | null | undefined, only?: ProviderKind): AiProvider {
  const last: { main?: string; fast?: string } = {}
  const onModel = (tier: Tier, model: string) => {
    last[tier] = model
  }
  const firstStep = () => buildSteps('main', pref, only)[0] ?? buildSteps('fast', pref, only)[0]

  return {
    get kind(): AiProviderKind {
      return only ?? firstStep()?.provider ?? 'anthropic'
    },
    get label(): string {
      const k = only ?? firstStep()?.provider
      return k ? getAdapter(k).label : 'AI'
    },
    configured() {
      return buildSteps('main', pref, only).length > 0 || buildSteps('fast', pref, only).length > 0
    },
    modelName(which: Tier = 'main') {
      return last[which] ?? buildSteps(which, pref, only)[0]?.model ?? ''
    },
    async generateStructured(req: StructuredRequest) {
      return (await runCascade(req.model ?? 'main', 'structured', req, pref, onModel, only)) as
        | Record<string, unknown>
        | null
    },
    async generateText(req: TextRequest) {
      return (await runCascade(req.model ?? 'main', 'text', req, pref, onModel, only)) as string | null
    },
  }
}

// ── Public selection API (unchanged signatures) ───────────────────────────────

export const AI_PROVIDERS: ReadonlyArray<{ kind: AiProviderKind; label: string }> = (
  ['gemini', 'anthropic', 'ollama'] as const
).map((k) => ({ kind: k, label: ADAPTERS[k].label }))

/** A single-provider view over the cascade (only that provider's steps). */
export function getProvider(kind: AiProviderKind): AiProvider {
  return makeProvider(null, kind)
}

export function anyAiConfigured(): boolean {
  return Object.values(ADAPTERS).some((a) => a.configured())
}

/**
 * Resolve the AI provider facade for this request. An explicit `pref` (e.g.
 * LifeOS's per-user synthesisProvider) is stably hoisted to the front of the
 * cascade; otherwise the hub-managed cascade order is used as-is. Returns null only
 * when NO step in either tier is configured (callers then use deterministic
 * non-AI fallbacks). Note: with a local Ollama endpoint configured, there is
 * effectively always a last-resort step, so null is rare.
 */
export function resolveAiProvider(pref?: string | null): AiProvider | null {
  const p = makeProvider(pref)
  return p.configured() ? p : null
}

/**
 * One-shot health/latency probe of a specific {provider, model} — backs the Hub's
 * per-step "Test" button. Sends a tiny text request and reports ok + round-trip ms.
 */
export async function probeModel(
  provider: ProviderKind,
  model: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const adapter = getAdapter(provider)
  if (!adapter) return { ok: false, ms: 0, error: `unknown provider '${provider}'` }
  if (!adapter.configured()) return { ok: false, ms: 0, error: 'not configured (missing key/endpoint)' }
  const start = Date.now()
  try {
    const out = await withTimeout(
      (signal) => adapter.callText(model, { prompt: 'Reply with exactly one word: ok', maxTokens: 8 }, signal),
      timeoutMs,
    )
    const ms = Date.now() - start
    return out.content != null ? { ok: true, ms } : { ok: false, ms, error: 'empty response' }
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: e instanceof Error ? e.message : String(e) }
  }
}
