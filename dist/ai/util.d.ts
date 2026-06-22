/** Extract the first JSON object from model text (tolerant of stray prose). */
export declare function parseJsonObject(text: string): Record<string, unknown> | null;
/** Strip `<think>…</think>` reasoning blocks emitted by thinking models (qwen3). */
export declare function stripThink(text: string): string;
export declare function toGeminiSchema(node: unknown): Record<string, unknown> | null;
