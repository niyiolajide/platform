import Anthropic from '@anthropic-ai/sdk'
import { keys } from '../config'
import type { AttemptRequest, ProviderAdapter, StructuredAttempt, TokenUsage } from './types'

// Single place all AI code gets its Anthropic client. The key is read live from
// process.env (sourced from shared.env); the model is chosen by the cascade.

let client: Anthropic | null = null

export function isAnthropicConfigured(): boolean {
  return Boolean(keys.anthropicApiKey())
}

export function getAnthropic(): Anthropic {
  // Explicit timeout + a single in-SDK retry: the cascade handles cross-provider
  // failover, so we fail fast to the next step rather than retrying here for long.
  if (!client)
    client = new Anthropic({ apiKey: keys.anthropicApiKey(), timeout: 60_000, maxRetries: 1 })
  return client
}

/** Test helper — reset the memoized client (e.g. after changing the env key). */
export function _resetAnthropic(): void {
  client = null
}

// ── Adapter ───────────────────────────────────────────────────────────────────
// One attempt per call; throws on API error; null only on empty/refusal. Uses
// native tool-use for forced, schema-shaped JSON.

export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',
  label: 'Claude (Anthropic)',
  configured: () => Boolean(keys.anthropicApiKey()),

  async callStructured(model, req: StructuredAttempt, signal) {
    const resp = await getAnthropic().messages.create(
      {
        model,
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
      },
      { signal },
    )
    const usage = anthropicUsage(resp)
    const tu = resp.content.find((b) => b.type === 'tool_use')
    if (!tu || tu.type !== 'tool_use') return { content: null, usage }
    return { content: tu.input as Record<string, unknown>, usage }
  },

  async callText(model, req: AttemptRequest, signal) {
    const resp = await getAnthropic().messages.create(
      {
        model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      },
      { signal },
    )
    const usage = anthropicUsage(resp)
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    return { content: text || null, usage }
  },
}

function anthropicUsage(resp: Anthropic.Message): TokenUsage {
  const u = resp.usage
  return { tokensIn: u?.input_tokens ?? undefined, tokensOut: u?.output_tokens ?? undefined }
}
