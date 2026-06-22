import { getLogger, keys } from '../config'
import type { AttemptRequest, ProviderAdapter, StructuredAttempt } from './types'
import { parseJsonObject, toGeminiSchema } from './util'

// Gemini (Google) adapter. Lazily requires the optional peer dep so apps that
// don't use Gemini need not install it. One attempt per call; throws on API
// error; null only on unparseable/empty output.

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

  async callStructured(model, req: StructuredAttempt, _signal) {
    const client = genai()
    if (!client) return null
    // Prefer controlled generation (responseSchema) for schema-faithful JSON; fall
    // back to mime-type-json + a prompt-appended schema when the schema uses
    // constructs the converter can't express.
    const responseSchema = toGeminiSchema(req.jsonSchema)
    const cfg = geminiGenConfig(model, req.maxTokens ?? 2048, true)
    const m = client.getGenerativeModel(
      {
        model,
        ...(req.system ? { systemInstruction: req.system } : {}),
        generationConfig: { ...cfg, ...(responseSchema ? { responseSchema } : {}) } as any,
      },
      { timeout: 60_000 },
    )
    const prompt = responseSchema
      ? req.prompt
      : `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`
    const resp = await m.generateContent(prompt)
    return parseJsonObject(resp.response.text())
  },

  async callText(model, req: AttemptRequest, _signal) {
    const client = genai()
    if (!client) return null
    const m = client.getGenerativeModel(
      {
        model,
        ...(req.system ? { systemInstruction: req.system } : {}),
        generationConfig: geminiGenConfig(model, req.maxTokens ?? 1024, false) as any,
      },
      { timeout: 60_000 },
    )
    const resp = await m.generateContent(req.prompt)
    return resp.response.text().trim() || null
  },
}
