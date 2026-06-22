"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADAPTERS = void 0;
exports.getAdapter = getAdapter;
const anthropic_1 = require("./anthropic");
const gemini_1 = require("./gemini");
const ollama_1 = require("./ollama");
// The one place provider kinds map to their adapter. The cascade executor and the
// `resolveAiProvider` facade both resolve through here.
exports.ADAPTERS = {
    gemini: gemini_1.geminiAdapter,
    anthropic: anthropic_1.anthropicAdapter,
    ollama: ollama_1.ollamaAdapter,
};
function getAdapter(kind) {
    return exports.ADAPTERS[kind];
}
