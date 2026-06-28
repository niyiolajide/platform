"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiAdapter = void 0;
const config_1 = require("../config");
const util_1 = require("./util");
let genaiMod = null;
let genaiClient = null;
async function genai() {
    if (!config_1.keys.geminiApiKey()) {
        return null;
    }
    if (!genaiMod) {
        try {
            genaiMod = await Promise.resolve().then(() => __importStar(require('@google/generative-ai')));
        }
        catch {
            (0, config_1.getLogger)().warn({}, '[ai/gemini] @google/generative-ai not installed');
            return null;
        }
    }
    genaiClient ?? (genaiClient = new genaiMod.GoogleGenerativeAI(config_1.keys.geminiApiKey()));
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
    async callStructured(model, req, signal) {
        const client = await genai();
        if (!client) {
            return { content: null };
        }
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
        const resp = await m.generateContent(prompt, { signal });
        return { content: (0, util_1.parseJsonObject)(resp.response.text()), usage: geminiUsage(resp) };
    },
    async callText(model, req, signal) {
        const client = await genai();
        if (!client) {
            return { content: null };
        }
        const m = client.getGenerativeModel({
            model,
            ...(req.system ? { systemInstruction: req.system } : {}),
            generationConfig: geminiGenConfig(model, req.maxTokens ?? 1024, false),
        }, { timeout: 60000 });
        const resp = await m.generateContent(req.prompt, { signal });
        return { content: resp.response.text().trim() || null, usage: geminiUsage(resp) };
    },
};
// Gemini reports usage on response.usageMetadata (prompt/candidates token counts).
function geminiUsage(resp) {
    const u = resp.response?.usageMetadata;
    return { tokensIn: u?.promptTokenCount ?? undefined, tokensOut: u?.candidatesTokenCount ?? undefined };
}
