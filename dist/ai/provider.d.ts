import type { ProviderKind } from '../control/schema';
export type AiProviderKind = ProviderKind;
export interface StructuredRequest {
    prompt: string;
    system?: string;
    toolName: string;
    toolDescription: string;
    jsonSchema: Record<string, unknown>;
    maxTokens?: number;
    model?: 'main' | 'fast';
}
export interface TextRequest {
    prompt: string;
    system?: string;
    maxTokens?: number;
    model?: 'main' | 'fast';
}
export interface AiProvider {
    kind: AiProviderKind;
    label: string;
    configured(): boolean;
    modelName(which?: 'main' | 'fast'): string;
    generateStructured(req: StructuredRequest): Promise<Record<string, unknown> | null>;
    generateText(req: TextRequest): Promise<string | null>;
}
export declare const AI_PROVIDERS: ReadonlyArray<{
    kind: AiProviderKind;
    label: string;
}>;
/** A single-provider view over the cascade (only that provider's steps). */
export declare function getProvider(kind: AiProviderKind): AiProvider;
export declare function anyAiConfigured(): boolean;
/**
 * Resolve the AI provider facade for this request. An explicit `pref` (e.g.
 * LifeOS's per-user synthesisProvider) is stably hoisted to the front of the
 * cascade; otherwise the hub-managed cascade order is used as-is. Returns null only
 * when NO step in either tier is configured (callers then use deterministic
 * non-AI fallbacks). Note: with a local Ollama endpoint configured, there is
 * effectively always a last-resort step, so null is rare.
 */
export declare function resolveAiProvider(pref?: string | null): AiProvider | null;
/**
 * One-shot health/latency probe of a specific {provider, model} — backs the Hub's
 * per-step "Test" button. Sends a tiny text request and reports ok + round-trip ms.
 */
export declare function probeModel(provider: ProviderKind, model: string, timeoutMs?: number): Promise<{
    ok: boolean;
    ms: number;
    error?: string;
}>;
