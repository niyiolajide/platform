import type { ProviderKind } from '../control/schema';
export type AiProviderKind = ProviderKind;
/**
 * Optional, additive telemetry attribution carried on every AI request. Purely
 * metadata for the AiCallRecord — it never affects model selection or output, so
 * the public AiProvider API stays backward-compatible (all fields optional).
 */
export interface AiCallOpts {
    /** Originating app; defaults to env APP_NAME when omitted. */
    app?: string;
    /** What this call is for (e.g. 'digest', 'classify-txn'). */
    purpose?: string;
    /** End-user the call is made for, if any. */
    userId?: string | null;
}
export interface StructuredRequest extends AiCallOpts {
    prompt: string;
    system?: string;
    toolName: string;
    toolDescription: string;
    jsonSchema: Record<string, unknown>;
    maxTokens?: number;
    model?: 'main' | 'fast';
}
export interface TextRequest extends AiCallOpts {
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
