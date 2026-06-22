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
export interface ProviderAdapter {
    kind: ProviderKind;
    label: string;
    /** True for on-host/LAN providers (Ollama): the executor skips anonymization. */
    local?: boolean;
    /** Whether this provider can be called at all (key present / endpoint set). */
    configured(): boolean;
    callStructured(model: string, req: StructuredAttempt, signal: AbortSignal): Promise<Record<string, unknown> | null>;
    callText(model: string, req: AttemptRequest, signal: AbortSignal): Promise<string | null>;
}
