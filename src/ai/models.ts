// Allowed model ids for the hub admin UI dropdowns. Not enforced at call time
// (the API accepts any string), but the UI offers these and validates against them.

export const AI_MODELS = {
  anthropic: [
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
  ],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
} as const

export type AnthropicModel = (typeof AI_MODELS.anthropic)[number]
export type GeminiModel = (typeof AI_MODELS.gemini)[number]
