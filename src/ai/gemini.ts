import { getLogger, keys } from '../config'
import type { AttemptRequest, ProviderAdapter, StructuredAttempt, TokenUsage } from './types'
import { parseJsonObject, toGeminiSchema } from './util'
import type * as GoogleGenAi from '@google/genai'

// Gemini (Google) adapter. Lazily requires the optional peer dep so apps that
// don't use Gemini need not install it. One attempt per call; throws on API
// error; null only on unparseable/empty output.

type GenAiModule = typeof GoogleGenAi
let genaiMod: GenAiModule | null = null
let genaiClient: GoogleGenAi.GoogleGenAI | null = null

async function genai(): Promise<GoogleGenAi.GoogleGenAI | null> {
  if (!keys.geminiApiKey()) {return null}
  if (!genaiMod) {
    try {
      genaiMod = await import('@google/genai')
    } catch {
      getLogger().warn({}, '[ai/gemini] @google/genai not installed')
      return null
    }
  }
  genaiClient ??= new genaiMod.GoogleGenAI({ apiKey: keys.geminiApiKey() })
  return genaiClient
}

// gemini-2.5-pro cannot disable "thinking" (thinkingBudget:0 is rejected) and its
// thinking consumes the output-token budget — so for pro we allow a bounded
// thinking budget and widen maxOutputTokens to avoid truncation. flash keeps
// thinkingBudget:0 (fastest, no truncation). flash-lite models are the exception:
// gemini-3.5-flash-lite rejects thinkingConfig.thinkingBudget:0 with 400
// "invalid argument" (live REST smoke, 2026-09-03) while accepting the field
// omitted, so flash-lite models get NO thinkingConfig at all.
function geminiGenConfig(
  model: string,
  maxTokens: number,
  json: boolean,
): GoogleGenAi.GenerateContentConfig {
  const isPro = /pro/i.test(model)
  const isFlashLite = /flash-lite/i.test(model)
  return {
    ...(json ? { responseMimeType: 'application/json' } : {}),
    maxOutputTokens: isPro ? Math.max(maxTokens, 4096) : maxTokens,
    ...(isFlashLite ? {} : { thinkingConfig: { thinkingBudget: isPro ? 1024 : 0 } }),
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
    const config: GoogleGenAi.GenerateContentConfig = {
      ...geminiGenConfig(model, req.maxTokens ?? 2048, true),
      ...(req.system ? { systemInstruction: req.system } : {}),
      ...(responseSchema ? { responseSchema } : {}),
      abortSignal: signal,
      httpOptions: { timeout: 60_000 },
    }
    const prompt = responseSchema
      ? req.prompt
      : `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`
    const resp = await client.models.generateContent({ model, contents: prompt, config })
    return { content: parseJsonObject(resp.text ?? ''), usage: geminiUsage(resp) }
  },

  async callText(model, req: AttemptRequest, signal) {
    const client = await genai()
    if (!client) {return { content: null }}
    const config: GoogleGenAi.GenerateContentConfig = {
      ...geminiGenConfig(model, req.maxTokens ?? 1024, false),
      ...(req.system ? { systemInstruction: req.system } : {}),
      abortSignal: signal,
      httpOptions: { timeout: 60_000 },
    }
    const resp = await client.models.generateContent({ model, contents: req.prompt, config })
    return { content: (resp.text ?? '').trim() || null, usage: geminiUsage(resp) }
  },
}

// Gemini reports usage on response.usageMetadata (prompt/candidates token counts).
function geminiUsage(resp: GoogleGenAi.GenerateContentResponse): TokenUsage {
  const u = resp.usageMetadata
  return { tokensIn: u?.promptTokenCount ?? undefined, tokensOut: u?.candidatesTokenCount ?? undefined }
}
