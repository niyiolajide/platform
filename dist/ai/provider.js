"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_PROVIDERS = void 0;
exports.getProvider = getProvider;
exports.anyAiConfigured = anyAiConfigured;
exports.resolveAiProvider = resolveAiProvider;
const config_1 = require("../config");
const store_1 = require("../control/store");
const anthropic_1 = require("./anthropic");
// ── Anthropic (Claude) ────────────────────────────────────────────────────────
const anthropicProvider = {
    kind: 'anthropic',
    label: 'Claude (Anthropic)',
    configured: () => Boolean(config_1.keys.anthropicApiKey()),
    modelName: (w) => {
        const s = (0, store_1.readAiSettings)();
        return w === 'fast' ? s.anthropicModelFast : s.anthropicModel;
    },
    async generateStructured(req) {
        try {
            const resp = await (0, anthropic_1.getAnthropic)().messages.create({
                model: this.modelName(req.model),
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
            });
            const tu = resp.content.find((b) => b.type === 'tool_use');
            return tu && tu.type === 'tool_use' ? tu.input : null;
        }
        catch (err) {
            (0, config_1.getLogger)().warn({ err }, '[ai/anthropic] structured generation failed');
            return null;
        }
    },
    async generateText(req) {
        try {
            const resp = await (0, anthropic_1.getAnthropic)().messages.create({
                model: this.modelName(req.model),
                max_tokens: req.maxTokens ?? 1024,
                ...(req.system ? { system: req.system } : {}),
                messages: [{ role: 'user', content: req.prompt }],
            });
            const text = resp.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
                .trim();
            return text || null;
        }
        catch (err) {
            (0, config_1.getLogger)().warn({ err }, '[ai/anthropic] text generation failed');
            return null;
        }
    },
};
let genaiMod = null;
let genaiClient = null;
function genai() {
    if (!config_1.keys.geminiApiKey())
        return null;
    if (!genaiMod) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            genaiMod = require('@google/generative-ai');
        }
        catch {
            (0, config_1.getLogger)().warn({}, '[ai/gemini] @google/generative-ai not installed');
            return null;
        }
    }
    if (!genaiClient)
        genaiClient = new genaiMod.GoogleGenerativeAI(config_1.keys.geminiApiKey());
    return genaiClient;
}
function geminiModels(which) {
    const s = (0, store_1.readAiSettings)();
    const primary = which === 'fast' ? s.geminiModelFast : s.geminiModel;
    return [...new Set([primary, s.geminiModelFallback].filter(Boolean))];
}
const geminiLastModel = {};
function parseJsonObject(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/\{[\s\S]*\}/);
    try {
        return JSON.parse(match ? match[0] : trimmed);
    }
    catch {
        return null;
    }
}
const geminiProvider = {
    kind: 'gemini',
    label: 'Gemini (Google)',
    configured: () => Boolean(config_1.keys.geminiApiKey()),
    modelName: (w) => {
        const which = w === 'fast' ? 'fast' : 'main';
        const s = (0, store_1.readAiSettings)();
        return geminiLastModel[which] ?? (which === 'fast' ? s.geminiModelFast : s.geminiModel);
    },
    async generateStructured(req) {
        const which = req.model === 'fast' ? 'fast' : 'main';
        const client = genai();
        if (!client)
            return null;
        const models = geminiModels(req.model);
        const prompt = `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`;
        for (let i = 0; i < models.length; i++) {
            const m = models[i];
            try {
                const model = client.getGenerativeModel({
                    model: m,
                    ...(req.system ? { systemInstruction: req.system } : {}),
                    // thinkingBudget:0 disables Gemini 2.5 "thinking" so it doesn't consume the
                    // output-token budget (otherwise answers truncate mid-sentence). Cast: this
                    // SDK version's GenerationConfig type doesn't include thinkingConfig yet.
                    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: req.maxTokens ?? 2048, thinkingConfig: { thinkingBudget: 0 } },
                });
                const resp = await model.generateContent(prompt);
                geminiLastModel[which] = m;
                return parseJsonObject(resp.response.text());
            }
            catch (err) {
                const willFallback = i < models.length - 1;
                (0, config_1.getLogger)().warn({ err, model: m, willFallback }, '[ai/gemini] structured generation failed');
                if (!willFallback)
                    return null;
            }
        }
        return null;
    },
    async generateText(req) {
        const which = req.model === 'fast' ? 'fast' : 'main';
        const client = genai();
        if (!client)
            return null;
        const models = geminiModels(req.model);
        for (let i = 0; i < models.length; i++) {
            const m = models[i];
            try {
                const model = client.getGenerativeModel({
                    model: m,
                    ...(req.system ? { systemInstruction: req.system } : {}),
                    // thinkingBudget:0 — see note above; keeps Gemini 2.5 from truncating output.
                    generationConfig: { maxOutputTokens: req.maxTokens ?? 1024, thinkingConfig: { thinkingBudget: 0 } },
                });
                const resp = await model.generateContent(req.prompt);
                geminiLastModel[which] = m;
                return resp.response.text().trim() || null;
            }
            catch (err) {
                const willFallback = i < models.length - 1;
                (0, config_1.getLogger)().warn({ err, model: m, willFallback }, '[ai/gemini] text generation failed');
                if (!willFallback)
                    return null;
            }
        }
        return null;
    },
};
// ── Selection ─────────────────────────────────────────────────────────────────
exports.AI_PROVIDERS = [
    { kind: 'anthropic', label: anthropicProvider.label },
    { kind: 'gemini', label: geminiProvider.label },
];
function getProvider(kind) {
    return kind === 'gemini' ? geminiProvider : anthropicProvider;
}
function anyAiConfigured() {
    return anthropicProvider.configured() || geminiProvider.configured();
}
/**
 * Resolve which provider to use. An explicit `pref` (e.g. LifeOS's per-user
 * synthesisProvider) wins; otherwise the hub-managed control-bus provider is used.
 * Falls back to the other configured provider when `fallbackEnabled`; returns null
 * if neither is configured (callers then use deterministic non-AI fallbacks).
 */
function resolveAiProvider(pref) {
    const settings = (0, store_1.readAiSettings)();
    const want = pref || settings.provider;
    const order = want === 'gemini' ? ['gemini', 'anthropic'] : ['anthropic', 'gemini'];
    const candidates = settings.fallbackEnabled ? order : [order[0]];
    for (const k of candidates) {
        const p = getProvider(k);
        if (p.configured())
            return p;
    }
    return null;
}
