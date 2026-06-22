export declare const AI_MODELS: {
    readonly anthropic: readonly ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-haiku-4-5"];
    readonly gemini: readonly ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
    readonly ollama: readonly ["qwen3:30b-a3b", "qwen3.5:9b"];
};
export type AnthropicModel = (typeof AI_MODELS.anthropic)[number];
export type GeminiModel = (typeof AI_MODELS.gemini)[number];
export type OllamaModel = (typeof AI_MODELS.ollama)[number];
