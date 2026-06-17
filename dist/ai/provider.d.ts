export type AiProviderKind = 'anthropic' | 'gemini';
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
export declare function getProvider(kind: AiProviderKind): AiProvider;
export declare function anyAiConfigured(): boolean;
/**
 * Resolve which provider to use. An explicit `pref` (e.g. LifeOS's per-user
 * synthesisProvider) wins; otherwise the hub-managed control-bus provider is used.
 * Falls back to the other configured provider when `fallbackEnabled`; returns null
 * if neither is configured (callers then use deterministic non-AI fallbacks).
 */
export declare function resolveAiProvider(pref?: string | null): AiProvider | null;
