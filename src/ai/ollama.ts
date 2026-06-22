import { readAiSettings } from '../control/store'
import type { AttemptRequest, ProviderAdapter, StructuredAttempt } from './types'
import { parseJsonObject, stripThink } from './util'

// Ollama (local, on-LAN) adapter. No API key. Because data never leaves the
// network, the executor skips anonymization for this provider (`local: true`).
// Uses Ollama's native JSON-schema `format` for structured output. `keep_alive`
// is passed through so the fallback model can be pinned warm (avoids cold-load).

async function ollamaGenerate(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const { baseUrl, keepAlive } = readAiSettings().ollama
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, think: false, keep_alive: keepAlive, ...body }),
    signal,
  })
  if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`)
  const data = (await resp.json()) as { response?: string }
  return data.response ?? ''
}

export const ollamaAdapter: ProviderAdapter = {
  kind: 'ollama',
  label: 'Ollama (local)',
  local: true,
  configured: () => Boolean(readAiSettings().ollama.baseUrl),

  async callStructured(model, req: StructuredAttempt, signal) {
    const text = await ollamaGenerate(
      {
        model,
        prompt: req.prompt,
        ...(req.system ? { system: req.system } : {}),
        format: req.jsonSchema,
        options: { num_predict: req.maxTokens ?? 2048 },
      },
      signal,
    )
    return parseJsonObject(stripThink(text))
  },

  async callText(model, req: AttemptRequest, signal) {
    const text = await ollamaGenerate(
      {
        model,
        prompt: req.prompt,
        ...(req.system ? { system: req.system } : {}),
        options: { num_predict: req.maxTokens ?? 1024 },
      },
      signal,
    )
    return stripThink(text).trim() || null
  },
}
