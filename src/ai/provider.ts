import type Anthropic from '@anthropic-ai/sdk'
import { getLogger, keys } from '../config'
import { readAiSettings } from '../control/store'
import { getAnthropic } from './anthropic'
import { createAnonymizer, type Anonymizer } from './anonymize'
import { AI_MODELS } from './models'

// ── Pluggable AI provider ─────────────────────────────────────────────────────
// One interface over Claude (Anthropic) and Gemini (Google) so every app's
// synthesis / insights / classification is provider-agnostic. The active provider
// + models + fallback come from the control bus (hub-managed), with env defaults.
// Ported from LifeOS's provider.ts; public signatures unchanged so call sites in
// the apps don't change.

export type AiProviderKind = 'anthropic' | 'gemini'

export interface StructuredRequest {
  prompt: string
  system?: string
  toolName: string
  toolDescription: string
  jsonSchema: Record<string, unknown>
  maxTokens?: number
  model?: 'main' | 'fast'
}

export interface TextRequest {
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

// ── Request anonymization ─────────────────────────────────────────────────────
// Gate on the hub-managed `anonymizeRequests` setting (default on). When enabled,
// PII in the prompt+system is reversibly tokenized BEFORE the API call (using one
// anonymizer instance so a value is consistent across both fields), and the
// returned `Anonymizer` is used to restore originals in the model's response.

function anonymizeReq<T extends { prompt: string; system?: string }>(
  req: T,
): { req: T; restore: Anonymizer | null } {
  if (!readAiSettings().anonymizeRequests) return { req, restore: null }
  const anon = createAnonymizer()
  const masked: T = {
    ...req,
    prompt: anon.mask(req.prompt),
    ...(req.system != null ? { system: anon.mask(req.system) } : {}),
  }
  return { req: masked, restore: anon }
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────

const anthropicProvider: AiProvider = {
  kind: 'anthropic',
  label: 'Claude (Anthropic)',
  configured: () => Boolean(keys.anthropicApiKey()),
  modelName: (w) => {
    const s = readAiSettings()
    return w === 'fast' ? s.anthropicModelFast : s.anthropicModel
  },
  async generateStructured(reqIn) {
    const { req, restore } = anonymizeReq(reqIn)
    try {
      const resp = await getAnthropic().messages.create({
        model: this.modelName(req.model),
        max_tokens: req.maxTokens ?? 2048,
        ...(req.system ? { system: req.system } : {}),
        tools: [
          {
            name: req.toolName,
            description: req.toolDescription,
            input_schema: req.jsonSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: req.toolName },
        messages: [{ role: 'user', content: req.prompt }],
      })
      const tu = resp.content.find((b) => b.type === 'tool_use')
      if (!tu || tu.type !== 'tool_use') return null
      const out = tu.input as Record<string, unknown>
      return restore ? restore.unmaskDeep(out) : out
    } catch (err) {
      getLogger().warn({ err }, '[ai/anthropic] structured generation failed')
      return null
    }
  },
  async generateText(reqIn) {
    const { req, restore } = anonymizeReq(reqIn)
    try {
      const resp = await getAnthropic().messages.create({
        model: this.modelName(req.model),
        max_tokens: req.maxTokens ?? 1024,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      })
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      if (!text) return null
      return restore ? restore.unmask(text) : text
    } catch (err) {
      getLogger().warn({ err }, '[ai/anthropic] text generation failed')
      return null
    }
  },
}

// ── Gemini (Google) ───────────────────────────────────────────────────────────
// Lazily required so apps that don't use Gemini need not install the optional peer.

type GenAiModule = typeof import('@google/generative-ai')
let genaiMod: GenAiModule | null = null
let genaiClient: import('@google/generative-ai').GoogleGenerativeAI | null = null

function genai(): import('@google/generative-ai').GoogleGenerativeAI | null {
  if (!keys.geminiApiKey()) return null
  if (!genaiMod) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      genaiMod = require('@google/generative-ai') as GenAiModule
    } catch {
      getLogger().warn({}, '[ai/gemini] @google/generative-ai not installed')
      return null
    }
  }
  if (!genaiClient) genaiClient = new genaiMod.GoogleGenerativeAI(keys.geminiApiKey())
  return genaiClient
}

// Failure cascade: try the configured primary + fallback first, then continue
// down ALL known Gemini models (best → cheapest) so a model outage/quota/5xx on
// one tier rolls down to the next instead of giving up. De-duplicated, order
// preserved.
function geminiModels(which?: 'main' | 'fast'): string[] {
  const s = readAiSettings()
  const primary = which === 'fast' ? s.geminiModelFast : s.geminiModel
  return [
    ...new Set([primary, s.geminiModelFallback, ...AI_MODELS.gemini].filter(Boolean) as string[]),
  ]
}

// gemini-2.5-pro cannot disable "thinking" (thinkingBudget:0 is rejected) and its
// thinking consumes the output-token budget — so for pro we allow a bounded
// thinking budget and widen maxOutputTokens to avoid truncation. flash/flash-lite
// keep thinkingBudget:0 (fastest, no truncation).
function geminiGenConfig(model: string, maxTokens: number, json: boolean): Record<string, unknown> {
  const isPro = /pro/i.test(model)
  return {
    ...(json ? { responseMimeType: 'application/json' } : {}),
    maxOutputTokens: isPro ? Math.max(maxTokens, 4096) : maxTokens,
    thinkingConfig: { thinkingBudget: isPro ? 1024 : 0 },
  }
}

const geminiLastModel: { main?: string; fast?: string } = {}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const match = trimmed.match(/\{[\s\S]*\}/)
  try {
    return JSON.parse(match ? match[0] : trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

const geminiProvider: AiProvider = {
  kind: 'gemini',
  label: 'Gemini (Google)',
  configured: () => Boolean(keys.geminiApiKey()),
  modelName: (w) => {
    const which = w === 'fast' ? 'fast' : 'main'
    const s = readAiSettings()
    return geminiLastModel[which] ?? (which === 'fast' ? s.geminiModelFast : s.geminiModel)
  },
  async generateStructured(reqIn) {
    const { req, restore } = anonymizeReq(reqIn)
    const which = req.model === 'fast' ? 'fast' : 'main'
    const client = genai()
    if (!client) return null
    const models = geminiModels(req.model)
    const prompt = `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`
    for (let i = 0; i < models.length; i++) {
      const m = models[i]
      try {
        const model = client.getGenerativeModel({
          model: m,
          ...(req.system ? { systemInstruction: req.system } : {}),
          // Cast: this SDK version's GenerationConfig type doesn't include thinkingConfig.
          generationConfig: geminiGenConfig(m, req.maxTokens ?? 2048, true) as any,
        })
        const resp = await model.generateContent(prompt)
        geminiLastModel[which] = m
        const out = parseJsonObject(resp.response.text())
        return out && restore ? restore.unmaskDeep(out) : out
      } catch (err) {
        const willFallback = i < models.length - 1
        getLogger().warn({ err, model: m, willFallback }, '[ai/gemini] structured generation failed')
        if (!willFallback) return null
      }
    }
    return null
  },
  async generateText(reqIn) {
    const { req, restore } = anonymizeReq(reqIn)
    const which = req.model === 'fast' ? 'fast' : 'main'
    const client = genai()
    if (!client) return null
    const models = geminiModels(req.model)
    for (let i = 0; i < models.length; i++) {
      const m = models[i]
      try {
        const model = client.getGenerativeModel({
          model: m,
          ...(req.system ? { systemInstruction: req.system } : {}),
          // Cast: see note in generateStructured.
          generationConfig: geminiGenConfig(m, req.maxTokens ?? 1024, false) as any,
        })
        const resp = await model.generateContent(req.prompt)
        geminiLastModel[which] = m
        const text = resp.response.text().trim() || null
        return text && restore ? restore.unmask(text) : text
      } catch (err) {
        const willFallback = i < models.length - 1
        getLogger().warn({ err, model: m, willFallback }, '[ai/gemini] text generation failed')
        if (!willFallback) return null
      }
    }
    return null
  },
}

// ── Selection ─────────────────────────────────────────────────────────────────

export const AI_PROVIDERS: ReadonlyArray<{ kind: AiProviderKind; label: string }> = [
  { kind: 'anthropic', label: anthropicProvider.label },
  { kind: 'gemini', label: geminiProvider.label },
]

export function getProvider(kind: AiProviderKind): AiProvider {
  return kind === 'gemini' ? geminiProvider : anthropicProvider
}

export function anyAiConfigured(): boolean {
  return anthropicProvider.configured() || geminiProvider.configured()
}

/**
 * Resolve which provider to use. An explicit `pref` (e.g. LifeOS's per-user
 * synthesisProvider) wins; otherwise the hub-managed control-bus provider is used.
 * Falls back to the other configured provider when `fallbackEnabled`; returns null
 * if neither is configured (callers then use deterministic non-AI fallbacks).
 */
export function resolveAiProvider(pref?: string | null): AiProvider | null {
  const settings = readAiSettings()
  const want: AiProviderKind = (pref as AiProviderKind) || settings.provider
  const order: AiProviderKind[] =
    want === 'gemini' ? ['gemini', 'anthropic'] : ['anthropic', 'gemini']
  const candidates = settings.fallbackEnabled ? order : [order[0]]
  for (const k of candidates) {
    const p = getProvider(k)
    if (p.configured()) return p
  }
  return null
}
