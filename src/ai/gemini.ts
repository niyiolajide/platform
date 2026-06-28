import { getLogger, keys } from '../config'
import type { AttemptRequest, ProviderAdapter, StructuredAttempt, TokenUsage } from './types'
import { parseJsonObject, toGeminiSchema } from './util'
import type * as GoogleGenAi from '@google/generative-ai'

// Gemini (Google) adapter. Lazily requires the optional peer dep so apps that
// don't use Gemini need not install it. One attempt per call; throws on API
// error; null only on unparseable/empty output.

type GenAiModule = typeof GoogleGenAi
let genaiMod: GenAiModule | null = null
let genaiClient: GoogleGenAi.GoogleGenerativeAI | null = null

async function genai(): Promise<GoogleGenAi.GoogleGenerativeAI | null> {
  if (!keys.geminiApiKey()) {return null}
  if (!genaiMod) {
    try {
      genaiMod = await import('@google/generative-ai')
    } catch {
      getLogger().warn({}, '[ai/gemini] @google/generative-ai not installed')
      return null
    }
  }
  genaiClient ??= new genaiMod.GoogleGenerativeAI(keys.geminiApiKey())
  return genaiClient
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

export const geminiAdapter: ProviderAdapter = {
  kind: 'gemini',
  label: 'Gemini (Google)',
  configured: () => Boolean(keys.geminiApiKey()),

  async callStructured(model, req: StructuredAttempt, signal) {
    const client = await genai()
    if (!client) {return { content: null }}
    // Prefer controlled generation (responseSchema) for schema-faithful JSON; fall
    // back to mime-type-json + a prompt-appended schema when the schema uses
    // constructs the converter can't express.
    const responseSchema = toGeminiSchema(req.jsonSchema)
    const cfg = geminiGenConfig(model, req.maxTokens ?? 2048, true)
    const m = client.getGenerativeModel(
      {
        model,
        ...(req.system ? { systemInstruction: req.system } : {}),
        generationConfig: { ...cfg, ...(responseSchema ? { responseSchema } : {}) },
      },
      { timeout: 60_000 },
    )
    const prompt = responseSchema
      ? req.prompt
      : `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`
    const resp = await m.generateContent(prompt, { signal })
    return { content: parseJsonObject(resp.response.text()), usage: geminiUsage(resp) }
  },

  async callText(model, req: AttemptRequest, signal) {
    const client = await genai()
    if (!client) {return { content: null }}
    const m = client.getGenerativeModel(
      {
        model,
        ...(req.system ? { systemInstruction: req.system } : {}),
        generationConfig: geminiGenConfig(model, req.maxTokens ?? 1024, false),
      },
      { timeout: 60_000 },
    )
    const resp = await m.generateContent(req.prompt, { signal })
    return { content: resp.response.text().trim() || null, usage: geminiUsage(resp) }
  },
}

// Gemini reports usage on response.usageMetadata (prompt/candidates token counts).
function geminiUsage(resp: { response?: { usageMetadata?: unknown } }): TokenUsage {
  const u = resp.response?.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined
  return { tokensIn: u?.promptTokenCount ?? undefined, tokensOut: u?.candidatesTokenCount ?? undefined }
}
