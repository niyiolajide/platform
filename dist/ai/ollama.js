"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ollamaAdapter = void 0;
const store_1 = require("../control/store");
const util_1 = require("./util");
// Ollama (local, on-LAN) adapter. No API key. Because data never leaves the
// network, the executor skips anonymization for this provider (`local: true`).
// Uses Ollama's native JSON-schema `format` for structured output. `keep_alive`
// is passed through so the fallback model can be pinned warm (avoids cold-load).
async function ollamaGenerate(body, signal) {
    const { baseUrl, keepAlive } = (0, store_1.readAiSettings)().ollama;
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false, think: false, keep_alive: keepAlive, ...body }),
        signal,
    });
    if (!resp.ok)
        throw new Error(`ollama HTTP ${resp.status}`);
    const data = (await resp.json());
    return data.response ?? '';
}
exports.ollamaAdapter = {
    kind: 'ollama',
    label: 'Ollama (local)',
    local: true,
    configured: () => Boolean((0, store_1.readAiSettings)().ollama.baseUrl),
    async callStructured(model, req, signal) {
        const text = await ollamaGenerate({
            model,
            prompt: req.prompt,
            ...(req.system ? { system: req.system } : {}),
            format: req.jsonSchema,
            options: { num_predict: req.maxTokens ?? 2048 },
        }, signal);
        return (0, util_1.parseJsonObject)((0, util_1.stripThink)(text));
    },
    async callText(model, req, signal) {
        const text = await ollamaGenerate({
            model,
            prompt: req.prompt,
            ...(req.system ? { system: req.system } : {}),
            options: { num_predict: req.maxTokens ?? 1024 },
        }, signal);
        return (0, util_1.stripThink)(text).trim() || null;
    },
};
