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
            genaiMod = await Promise.resolve().then(() => __importStar(require('@google/genai')));
        }
        catch {
            (0, config_1.getLogger)().warn({}, '[ai/gemini] @google/genai not installed');
            return null;
        }
    }
    genaiClient ?? (genaiClient = new genaiMod.GoogleGenAI({ apiKey: config_1.keys.geminiApiKey() }));
    return genaiClient;
}
// gemini-2.5-pro cannot disable "thinking" (thinkingBudget:0 is rejected) and its
// thinking consumes the output-token budget — so for pro we allow a bounded
// thinking budget and widen maxOutputTokens to avoid truncation. flash keeps
// thinkingBudget:0 (fastest, no truncation). flash-lite models are the exception:
// gemini-3.5-flash-lite rejects thinkingConfig.thinkingBudget:0 with 400
// "invalid argument" (live REST smoke, 2026-09-03) while accepting the field
// omitted, so flash-lite models get NO thinkingConfig at all.
function geminiGenConfig(model, maxTokens, json) {
    const isPro = /pro/i.test(model);
    const isFlashLite = /flash-lite/i.test(model);
    return {
        ...(json ? { responseMimeType: 'application/json' } : {}),
        maxOutputTokens: isPro ? Math.max(maxTokens, 4096) : maxTokens,
        ...(isFlashLite ? {} : { thinkingConfig: { thinkingBudget: isPro ? 1024 : 0 } }),
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
        const config = {
            ...geminiGenConfig(model, req.maxTokens ?? 2048, true),
            ...(req.system ? { systemInstruction: req.system } : {}),
            ...(responseSchema ? { responseSchema } : {}),
            abortSignal: signal,
            httpOptions: { timeout: 60000 },
        };
        const prompt = responseSchema
            ? req.prompt
            : `${req.prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(req.jsonSchema)}`;
        const resp = await client.models.generateContent({ model, contents: prompt, config });
        return { content: (0, util_1.parseJsonObject)(resp.text ?? ''), usage: geminiUsage(resp) };
    },
    async callText(model, req, signal) {
        const client = await genai();
        if (!client) {
            return { content: null };
        }
        const config = {
            ...geminiGenConfig(model, req.maxTokens ?? 1024, false),
            ...(req.system ? { systemInstruction: req.system } : {}),
            abortSignal: signal,
            httpOptions: { timeout: 60000 },
        };
        const resp = await client.models.generateContent({ model, contents: req.prompt, config });
        return { content: (resp.text ?? '').trim() || null, usage: geminiUsage(resp) };
    },
};
// Gemini reports usage on response.usageMetadata (prompt/candidates token counts).
function geminiUsage(resp) {
    const u = resp.usageMetadata;
    return { tokensIn: u?.promptTokenCount ?? undefined, tokensOut: u?.candidatesTokenCount ?? undefined };
}
