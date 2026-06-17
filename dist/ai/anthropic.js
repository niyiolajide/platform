"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAnthropicConfigured = isAnthropicConfigured;
exports.getAnthropic = getAnthropic;
exports._resetAnthropic = _resetAnthropic;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
// Single place all AI code gets its Anthropic client. The key is read live from
// process.env (sourced from shared.env); models come from the control bus.
let client = null;
function isAnthropicConfigured() {
    return Boolean(config_1.keys.anthropicApiKey());
}
function getAnthropic() {
    if (!client)
        client = new sdk_1.default({ apiKey: config_1.keys.anthropicApiKey() });
    return client;
}
/** Test helper — reset the memoized client (e.g. after changing the env key). */
function _resetAnthropic() {
    client = null;
}
