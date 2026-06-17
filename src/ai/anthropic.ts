import Anthropic from '@anthropic-ai/sdk'
import { keys } from '../config'

// Single place all AI code gets its Anthropic client. The key is read live from
// process.env (sourced from shared.env); models come from the control bus.

let client: Anthropic | null = null

export function isAnthropicConfigured(): boolean {
  return Boolean(keys.anthropicApiKey())
}

export function getAnthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: keys.anthropicApiKey() })
  return client
}

/** Test helper — reset the memoized client (e.g. after changing the env key). */
export function _resetAnthropic(): void {
  client = null
}
