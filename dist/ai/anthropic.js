"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.anthropicAdapter = void 0;
exports.isAnthropicConfigured = isAnthropicConfigured;
exports.getAnthropic = getAnthropic;
exports._resetAnthropic = _resetAnthropic;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
// Single place all AI code gets its Anthropic client. The key is read live from
// process.env (sourced from shared.env); the model is chosen by the cascade.
let client = null;
function isAnthropicConfigured() {
    return Boolean(config_1.keys.anthropicApiKey());
}
function getAnthropic() {
    // Explicit timeout + a single in-SDK retry: the cascade handles cross-provider
    // failover, so we fail fast to the next step rather than retrying here for long.
    if (!client)
        client = new sdk_1.default({ apiKey: config_1.keys.anthropicApiKey(), timeout: 60000, maxRetries: 1 });
    return client;
}
/** Test helper — reset the memoized client (e.g. after changing the env key). */
function _resetAnthropic() {
    client = null;
}
// ── Adapter ───────────────────────────────────────────────────────────────────
// One attempt per call; throws on API error; null only on empty/refusal. Uses
// native tool-use for forced, schema-shaped JSON.
exports.anthropicAdapter = {
    kind: 'anthropic',
    label: 'Claude (Anthropic)',
    configured: () => Boolean(config_1.keys.anthropicApiKey()),
    async callStructured(model, req, signal) {
        const resp = await getAnthropic().messages.create({
            model,
            max_tokens: req.maxTokens ?? 2048,
            ...(req.system ? { system: req.system } : {}),
            tools: [
                {
                    name: req.toolName,
                    description: req.toolDescription,
                    input_schema: req.jsonSchema,
                },
            ],
            tool_choice: { type: 'tool', name: req.toolName },
            messages: [{ role: 'user', content: req.prompt }],
        }, { signal });
        const tu = resp.content.find((b) => b.type === 'tool_use');
        if (!tu || tu.type !== 'tool_use')
            return null;
        return tu.input;
    },
    async callText(model, req, signal) {
        const resp = await getAnthropic().messages.create({
            model,
            max_tokens: req.maxTokens ?? 1024,
            ...(req.system ? { system: req.system } : {}),
            messages: [{ role: 'user', content: req.prompt }],
        }, { signal });
        const text = resp.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        return text || null;
    },
};
