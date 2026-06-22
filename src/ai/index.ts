export { getAnthropic, isAnthropicConfigured, _resetAnthropic } from './anthropic'
export {
  type AiProviderKind,
  type AiProvider,
  type AiCallOpts,
  type StructuredRequest,
  type TextRequest,
  AI_PROVIDERS,
  getProvider,
  anyAiConfigured,
  resolveAiProvider,
  probeModel,
} from './provider'
// Convenience re-exports so an app can `import { resolveAiProvider, AI_MODELS } from '@niyi/platform/ai'`
export { AI_SETTINGS_SCHEMA, type AiSettings } from '../control/schema'
export { readAiSettings, aiConfigSource } from '../control/store'
export {
  AI_MODELS,
  type AnthropicModel,
  type GeminiModel,
  type ModelPrice,
  MODEL_PRICES,
  priceFor,
  estimateCostCents,
} from './models'
export { createAnonymizer, type Anonymizer, type PiiCategory } from './anonymize'
// ── AI-call telemetry ─────────────────────────────────────────────────────────
export {
  type AiCallRecord,
  type AiTelemetrySink,
  type RedisLike,
  setAiTelemetrySink,
  hasAiTelemetrySink,
  recordAiCall,
  ulid,
  createRedisSink,
  shipBuffer,
  AI_TELEMETRY_BUFFER_KEY,
} from './telemetry'
