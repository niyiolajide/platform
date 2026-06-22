"use strict";
// Small shared helpers for the JSON-producing providers (Gemini, Ollama).
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJsonObject = parseJsonObject;
exports.stripThink = stripThink;
exports.toGeminiSchema = toGeminiSchema;
/** Extract the first JSON object from model text (tolerant of stray prose). */
function parseJsonObject(text) {
    const trimmed = (text ?? '').trim();
    if (!trimmed)
        return null;
    const match = trimmed.match(/\{[\s\S]*\}/);
    try {
        return JSON.parse(match ? match[0] : trimmed);
    }
    catch {
        return null;
    }
}
/** Strip `<think>…</think>` reasoning blocks emitted by thinking models (qwen3). */
function stripThink(text) {
    return (text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
// Best-effort JSON Schema → Gemini responseSchema converter. Handles the common
// subset the apps use (object/array/string/number/integer/boolean + enum/required/
// description). Returns null on anything unsupported (anyOf/oneOf/$ref/tuples) so
// the caller falls back to mime-type-json + prompt-appended schema.
function toGeminiSchema(node) {
    if (!node || typeof node !== 'object')
        return null;
    const n = node;
    const t = n.type;
    const desc = n.description ? { description: n.description } : {};
    if (t === 'object') {
        const props = {};
        for (const [k, v] of Object.entries(n.properties ?? {})) {
            const c = toGeminiSchema(v);
            if (c == null)
                return null;
            props[k] = c;
        }
        return {
            type: 'object',
            properties: props,
            ...(Array.isArray(n.required) ? { required: n.required } : {}),
            ...desc,
        };
    }
    if (t === 'array') {
        const items = toGeminiSchema(n.items);
        if (items == null)
            return null;
        return { type: 'array', items, ...desc };
    }
    if (t === 'string') {
        return Array.isArray(n.enum)
            ? { type: 'string', format: 'enum', enum: n.enum, ...desc }
            : { type: 'string', ...desc };
    }
    if (t === 'number' || t === 'integer' || t === 'boolean') {
        return { type: t, ...desc };
    }
    return null;
}
