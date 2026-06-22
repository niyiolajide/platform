export declare const AI_MODELS: {
    readonly anthropic: readonly ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-haiku-4-5"];
    readonly gemini: readonly ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
    readonly ollama: readonly ["qwen3:30b-a3b", "qwen3.5:9b"];
};
export type AnthropicModel = (typeof AI_MODELS.anthropic)[number];
export type GeminiModel = (typeof AI_MODELS.gemini)[number];
export type OllamaModel = (typeof AI_MODELS.ollama)[number];
export interface ModelPrice {
    /** Model id (or id prefix) the price applies to. */
    model: string;
    /** Cents per 1,000,000 input tokens. */
    per1MInCents: number;
    /** Cents per 1,000,000 output tokens. */
    per1MOutCents: number;
    /** ISO date (YYYY-MM-DD) the price took effect — newest matching row wins. */
    since: string;
}
export declare const MODEL_PRICES: ModelPrice[];
/**
 * Resolve the price row for a model at a point in time. Exact id match wins; else
 * the longest id-prefix match (so dated variants like `…-20251001` map to the base
 * id). Among rows that match, the newest `since` not after `at` is chosen. Returns
 * null for unknown models (caller then omits cost).
 */
export declare function priceFor(model: string, at?: Date): ModelPrice | null;
/**
 * Best-effort estimated cost in cents for a call. Returns undefined when the model
 * is unpriced or token counts are unavailable (cost is then omitted from the record).
 */
export declare function estimateCostCents(model: string, tokensIn: number | undefined, tokensOut: number | undefined, at?: Date): number | undefined;
