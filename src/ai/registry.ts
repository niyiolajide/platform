import type { ProviderKind } from '../control/schema'
import type { ProviderAdapter } from './types'
import { anthropicAdapter } from './anthropic'
import { geminiAdapter } from './gemini'
import { ollamaAdapter } from './ollama'

// The one place provider kinds map to their adapter. The cascade executor and the
// `resolveAiProvider` facade both resolve through here.
export const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
  ollama: ollamaAdapter,
}

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  return ADAPTERS[kind]
}
