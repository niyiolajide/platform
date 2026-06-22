"use strict";
// Allowed model ids for the hub admin UI dropdowns. Not enforced at call time
// (the API accepts any string), but the UI offers these and validates against them.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_MODELS = void 0;
exports.AI_MODELS = {
    anthropic: [
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-haiku-4-5',
    ],
    // Ordered best → cheapest.
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    // Local models served by Ollama on media001 (on-LAN; no API key, no anonymization).
    ollama: ['qwen3:30b-a3b', 'qwen3.5:9b'],
};
