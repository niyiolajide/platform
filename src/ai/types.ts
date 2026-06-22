import type { ProviderKind } from '../control/schema'

// ── Provider adapter contract ─────────────────────────────────────────────────
// An adapter is a THIN wrapper over one provider: given a concrete model and a
// single request, it makes ONE API call. It THROWS on an API error (the cascade
// executor catches and falls to the next step) and returns `null` only on an
// empty / refused response. No retries, no model fallback, no anonymization — the
// executor owns all of that. `prompt`/`system` arrive already prepared (masked or
// not, per the executor's policy for this step).

export interface AttemptRequest {
  prompt: string
  system?: string
  maxTokens?: number
}

export interface StructuredAttempt extends AttemptRequest {
  toolName: string
  toolDescription: string
  jsonSchema: Record<string, unknown>
}

/** Token usage reported by a provider for one attempt (best-effort; may be absent). */
export interface TokenUsage {
  tokensIn?: number
  tokensOut?: number
}

/**
 * One adapter attempt's outcome. `content` is null on an empty/refused response;
 * `usage` is the provider's reported token counts when available (used for
 * telemetry/cost). Returning usage even on a null `content` is allowed.
 */
export interface AttemptResult<T> {
  content: T | null
  usage?: TokenUsage
}

export interface ProviderAdapter {
  kind: ProviderKind
  label: string
  /** True for on-host/LAN providers (Ollama): the executor skips anonymization. */
  local?: boolean
  /** Whether this provider can be called at all (key present / endpoint set). */
  configured(): boolean
  callStructured(
    model: string,
    req: StructuredAttempt,
    signal: AbortSignal,
  ): Promise<AttemptResult<Record<string, unknown>>>
  callText(model: string, req: AttemptRequest, signal: AbortSignal): Promise<AttemptResult<string>>
}
