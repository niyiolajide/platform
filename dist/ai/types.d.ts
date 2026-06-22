import type { ProviderKind } from '../control/schema';
export interface AttemptRequest {
    prompt: string;
    system?: string;
    maxTokens?: number;
}
export interface StructuredAttempt extends AttemptRequest {
    toolName: string;
    toolDescription: string;
    jsonSchema: Record<string, unknown>;
}
/** Token usage reported by a provider for one attempt (best-effort; may be absent). */
export interface TokenUsage {
    tokensIn?: number;
    tokensOut?: number;
}
/**
 * One adapter attempt's outcome. `content` is null on an empty/refused response;
 * `usage` is the provider's reported token counts when available (used for
 * telemetry/cost). Returning usage even on a null `content` is allowed.
 */
export interface AttemptResult<T> {
    content: T | null;
    usage?: TokenUsage;
}
export interface ProviderAdapter {
    kind: ProviderKind;
    label: string;
    /** True for on-host/LAN providers (Ollama): the executor skips anonymization. */
    local?: boolean;
    /** Whether this provider can be called at all (key present / endpoint set). */
    configured(): boolean;
    callStructured(model: string, req: StructuredAttempt, signal: AbortSignal): Promise<AttemptResult<Record<string, unknown>>>;
    callText(model: string, req: AttemptRequest, signal: AbortSignal): Promise<AttemptResult<string>>;
}
