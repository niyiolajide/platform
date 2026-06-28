import { getLogger } from '../config'
import { readAiSettings } from '../control/store'
import type { CascadeStep, ProviderKind } from '../control/schema'
import { createAnonymizer, type Anonymizer } from './anonymize'
import { estimateCostCents } from './models'
import { ADAPTERS, getAdapter } from './registry'
import { hasAiTelemetrySink, recordAiCall, ulid, type AiCallRecord } from './telemetry'
import type { AttemptResult, TokenUsage } from './types'

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
type CascadeRequest = StructuredRequest | TextRequest
type CascadeOutput = Record<string, unknown> | string
type ModelCallback = (tier: Tier, model: string) => void
type RunCascadeArgs = { tier: Tier; kind: Kind; req: CascadeRequest; pref?: string | null; onModel: ModelCallback; only?: ProviderKind }
type TelemetryState = { enabled: boolean; logPayloads: boolean; app: string; purpose: string; userId: string | null; tier: Tier; anon: Anonymizer | null }
type EmitArgs = { telemetry: TelemetryState; step: CascadeStep; attempt: number; status: AiCallRecord['status']; ms: number; prompt: string; response?: string; usage?: TokenUsage; error?: string }
type CallArgs = { kind: Kind; req: CascadeRequest; step: CascadeStep; prompt: string; system?: string; signal: AbortSignal }
type AttemptArgs = Omit<CallArgs, 'signal'> & { tier: Tier; attempt: number; willFallback: boolean; telemetry: TelemetryState; onModel: ModelCallback; anonForRestore: Anonymizer | null }

// Per-attempt deadline so a hung call falls through to the next step. Ollama gets a
// wider budget for a possible cold model-load (mitigated by keep_alive pinning).
const TIMEOUT_MS: Record<ProviderKind, number> = {
  gemini: 60_000,
  anthropic: 60_000,
  ollama: 180_000,
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`attempt timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([fn(ac.signal), timeout])
  } finally {
    if (timer != null) {clearTimeout(timer)}
  }
}

// Build the ordered, configured step list for a tier. An explicit `pref` provider
// is stably hoisted to the front; `only` restricts to a single provider (used by
// the historical single-provider `getProvider`).
function buildSteps(tier: Tier, pref?: string | null, only?: ProviderKind): CascadeStep[] {
  let steps = readAiSettings().cascades[tier].filter((s) => getAdapter(s.provider).configured())
  if (only) {steps = steps.filter((s) => s.provider === only)}
  if (pref) {
    const p = pref as ProviderKind
    steps = [...steps.filter((s) => s.provider === p), ...steps.filter((s) => s.provider !== p)]
  }
  return steps
}

function first<T>(items: readonly T[]): T | undefined {
  const [value] = items
  return value
}

function makeTelemetryState(
  settings: ReturnType<typeof readAiSettings>,
  tier: Tier,
  req: CascadeRequest,
  anon: Anonymizer | null,
): TelemetryState {
  return {
    enabled: settings.logAiCalls && hasAiTelemetrySink(),
    logPayloads: settings.logPayloads,
    app: req.app ?? process.env.APP_NAME ?? 'unknown',
    purpose: req.purpose ?? 'unknown',
    userId: req.userId ?? null,
    tier,
    anon,
  }
}

function emitAttempt(args: EmitArgs): void {
  const { telemetry, step, attempt, status, ms, prompt, response, usage, error } = args
  if (!telemetry.enabled) {return}
  const rec: AiCallRecord = {
    id: ulid(), ts: new Date().toISOString(), app: telemetry.app, userId: telemetry.userId,
    purpose: telemetry.purpose, caller: 'cascade', tier: telemetry.tier, provider: step.provider,
    model: step.model, attempt, status, error: error ?? null, latencyMs: ms,
    ...(usage?.tokensIn != null ? { tokensIn: usage.tokensIn } : {}),
    ...(usage?.tokensOut != null ? { tokensOut: usage.tokensOut } : {}),
  }
  const cost = estimateCostCents(step.model, usage?.tokensIn, usage?.tokensOut)
  if (cost != null) {rec.costCentsEst = cost}
  if (telemetry.logPayloads) {
    rec.prompt = prompt
    if (response != null) {rec.response = response}
  }
  const nameCandidates = telemetry.anon?.possibleUnmaskedNames() ?? []
  if (nameCandidates.length > 0) {rec.unmaskedNameCandidates = nameCandidates}
  recordAiCall(rec)
}

function callStep(args: CallArgs): Promise<AttemptResult<CascadeOutput>> {
  const adapter = getAdapter(args.step.provider)
  if (args.kind === 'structured') {
    const req = args.req as StructuredRequest
    return adapter.callStructured(args.step.model, {
      prompt: args.prompt, system: args.system, maxTokens: req.maxTokens,
      toolName: req.toolName, toolDescription: req.toolDescription, jsonSchema: req.jsonSchema,
    }, args.signal)
  }
  return adapter.callText(args.step.model, { prompt: args.prompt, system: args.system, maxTokens: args.req.maxTokens }, args.signal)
}

function restoreOutput(kind: Kind, out: CascadeOutput, anon: Anonymizer | null): CascadeOutput {
  if (anon == null) {return out}
  return kind === 'structured' ? anon.unmaskDeep(out as Record<string, unknown>) : anon.unmask(out as string)
}

async function runAttempt(args: AttemptArgs): Promise<CascadeOutput | null> {
  const startedAt = Date.now()
  try {
    const result = await withTimeout((signal) => callStep({ ...args, signal }), TIMEOUT_MS[args.step.provider])
    const ms = Date.now() - startedAt
    const out = result.content
    if (out == null) {
      getLogger().warn({ tier: args.tier, kind: args.kind, provider: args.step.provider, model: args.step.model, attempt: args.attempt, ms, reason: 'empty', willFallback: args.willFallback }, '[ai/cascade] empty response')
      emitAttempt({ telemetry: args.telemetry, step: args.step, attempt: args.attempt, status: 'empty', ms, prompt: args.prompt, usage: result.usage })
      return null
    }
    args.onModel(args.tier, args.step.model)
    getLogger().info({ tier: args.tier, kind: args.kind, provider: args.step.provider, model: args.step.model, attempt: args.attempt, ms }, '[ai/cascade] answered')
    const restored = restoreOutput(args.kind, out, args.anonForRestore)
    const response = typeof restored === 'string' ? restored : JSON.stringify(restored)
    emitAttempt({ telemetry: args.telemetry, step: args.step, attempt: args.attempt, status: 'ok', ms, prompt: args.prompt, response, usage: result.usage })
    return restored
  } catch (err: unknown) {
    const ms = Date.now() - startedAt
    const error = err instanceof Error ? err.message : String(err)
    getLogger().warn({ err, tier: args.tier, kind: args.kind, provider: args.step.provider, model: args.step.model, attempt: args.attempt, ms, willFallback: args.willFallback }, '[ai/cascade] attempt failed')
    emitAttempt({ telemetry: args.telemetry, step: args.step, attempt: args.attempt, status: 'error', ms, prompt: args.prompt, error })
    return null
  }
}

async function runCascade(args: RunCascadeArgs): Promise<CascadeOutput | null> {
  const { tier, kind, req, pref, only, onModel } = args
  const settings = readAiSettings()
  const steps = buildSteps(tier, pref, only)
  if (steps.length === 0) {return null}

  // Anonymize ONCE, reused across all cloud attempts. Local (Ollama) steps keep the
  // original text — data never leaves the LAN, so masking would only cost fidelity.
  const anon: Anonymizer | null = settings.anonymizeRequests ? createAnonymizer() : null
  const maskedPrompt = anon ? anon.mask(req.prompt) : req.prompt
  const maskedSystem = anon && req.system != null ? anon.mask(req.system) : req.system
  const telemetry = makeTelemetryState(settings, tier, req, anon)

  for (const [i, step] of steps.entries()) {
    const adapter = getAdapter(step.provider)
    const useMask = anon != null && adapter.local !== true
    const prompt = useMask ? maskedPrompt : req.prompt
    const system = useMask ? maskedSystem : req.system
    const out = await runAttempt({ tier, kind, req, step, attempt: i + 1, willFallback: i < steps.length - 1, prompt, system, telemetry, onModel, anonForRestore: useMask ? anon : null })
    if (out != null) {return out}
  }
  getLogger().warn({ tier, kind, attempts: steps.length }, '[ai/cascade] all steps failed')
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
  const firstStep = () => first(buildSteps('main', pref, only)) ?? first(buildSteps('fast', pref, only))

  return {
    get kind(): AiProviderKind {
      return only ?? firstStep()?.provider ?? 'anthropic'
    },
    get label(): string {
      const k = only ?? firstStep()?.provider
      return k != null ? getAdapter(k).label : 'AI'
    },
    configured() {
      return buildSteps('main', pref, only).length > 0 || buildSteps('fast', pref, only).length > 0
    },
    modelName(which: Tier = 'main') {
      return last[which] ?? first(buildSteps(which, pref, only))?.model ?? ''
    },
    async generateStructured(req: StructuredRequest) {
      return (await runCascade({ tier: req.model ?? 'main', kind: 'structured', req, pref, onModel, only })) as
        | Record<string, unknown>
        | null
    },
    async generateText(req: TextRequest) {
      return (await runCascade({ tier: req.model ?? 'main', kind: 'text', req, pref, onModel, only })) as string | null
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

function isProviderKind(provider: string): provider is ProviderKind {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, provider)
}

/**
 * One-shot health/latency probe of a specific {provider, model} — backs the Hub's
 * per-step "Test" button. Sends a tiny text request and reports ok + round-trip ms.
 */
export async function probeModel(
  provider: string,
  model: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  if (!isProviderKind(provider)) {return { ok: false, ms: 0, error: `unknown provider '${provider}'` }}
  const adapter = getAdapter(provider)
  if (!adapter.configured()) {return { ok: false, ms: 0, error: 'not configured (missing key/endpoint)' }}
  const start = Date.now()
  try {
    const out: AttemptResult<string> = await withTimeout(
      (signal) => adapter.callText(model, { prompt: 'Reply with exactly one word: ok', maxTokens: 8 }, signal),
      timeoutMs,
    )
    const ms = Date.now() - start
    if (out.content == null) {return { ok: false, ms, error: 'empty response' }}
    return { ok: true, ms }
  } catch (err: unknown) {
    return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}
