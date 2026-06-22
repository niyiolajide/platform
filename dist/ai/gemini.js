"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiAdapter = void 0;
const config_1 = require("../config");
const util_1 = require("./util");
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
// gemini-2.5-pro cannot disable "thinking" (thinkingBudget:0 is rejected) and its
// thinking consumes the output-token budget — so for pro we allow a bounded
// thinking budget and widen maxOutputTokens to avoid truncation. flash/flash-lite
// keep thinkingBudget:0 (fastest, no truncation).
function geminiGenConfig(model, maxTokens, json) {
    const isPro = /pro/i.test(model);
    return {
        ...(json ? { responseMimeType: 'application/json' } : {}),
        maxOutputTokens: isPro ? Math.max(maxTokens, 4096) : maxTokens,
        thinkingConfig: { thinkingBudget: isPro ? 1024 : 0 },
    };
}
exports.geminiAdapter = {
    kind: 'gemini',
    label: 'Gemini (Google)',
    configured: () => Boolean(config_1.keys.geminiApiKey()),
    async callStructured(model, req, _signal) {
        const client = genai();
        if (!client)
            return null;
        // Prefer controlled generation (responseSchema) for schema-faithful JSON; fall
        // back to mime-type-json + a prompt-appended schema when the schema uses
        // constructs the converter can't express.
        const responseSchema = (0, util_1.toGeminiSchema)(req.jsonSchema);
        const cfg = geminiGenConfig(model, req.maxTokens ?? 2048, true);
        const m = client.getGenerativeModel({
            model,
            ...(req.system ? { systemInstruction: req.system } : {}),
            generationConfig: { ...cfg, ...(responseSchema ? { responseSchema } : {}) },
        }, { timeout: 60000 });
        const prompt = responseSchema
            ? req.prompt
            : `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`;
        const resp = await m.generateContent(prompt);
        return (0, util_1.parseJsonObject)(resp.response.text());
    },
    async callText(model, req, _signal) {
        const client = genai();
        if (!client)
            return null;
        const m = client.getGenerativeModel({
            model,
            ...(req.system ? { systemInstruction: req.system } : {}),
            generationConfig: geminiGenConfig(model, req.maxTokens ?? 1024, false),
        }, { timeout: 60000 });
        const resp = await m.generateContent(req.prompt);
        return resp.response.text().trim() || null;
    },
};
