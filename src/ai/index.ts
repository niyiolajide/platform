export { getAnthropic, isAnthropicConfigured, _resetAnthropic } from './anthropic'
export {
  type AiProviderKind,
  type AiProvider,
  type StructuredRequest,
  type TextRequest,
  AI_PROVIDERS,
  getProvider,
  anyAiConfigured,
  resolveAiProvider,
} from './provider'
// Convenience re-exports so an app can `import { resolveAiProvider, AI_MODELS } from '@niyi/platform/ai'`
export { AI_SETTINGS_SCHEMA, type AiSettings } from '../control/schema'
export { readAiSettings, aiConfigSource } from '../control/store'
export { AI_MODELS, type AnthropicModel, type GeminiModel } from './models'
