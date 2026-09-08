"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAiSettings = readAiSettings;
exports.aiConfigSource = aiConfigSource;
exports.readApps = readApps;
exports.readNotifySettings = readNotifySettings;
exports.publishAiSettings = publishAiSettings;
exports.publishNotifySettings = publishNotifySettings;
exports._clearCache = _clearCache;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const reader_1 = require("./reader");
const writer_1 = require("./writer");
const schema_1 = require("./schema");
// ── Control-bundle file-bus ───────────────────────────────────────────────────
// The hub publishes JSON to a shared volume (default /control); apps read it
// OFFLINE — no network call, so the hub being down never blocks an app. Reads are
// fingerprint-cached (cheap on the hot path, near-real-time after a hub edit) and
// validated for snapshot stability (reader.ts); publication is temp + fsync + rename
// (writer.ts). The security-critical revocation denylist lives in revocations.ts —
// the bundles here are deliberately TOLERANT: a missing file means env/defaults.
const CONTROL_DIR = () => process.env.CONTROL_DIR ?? '/control';
/**
 * Optional bundles are tolerant by design, but a torn read of a file that DOES exist
 * must not be mistaken for absence — that silently downgrades a published config to
 * env defaults. Retry the transient classes; a genuinely absent file still
 * short-circuits on the first attempt and costs nothing.
 */
const OPTIONAL_READ = { attempts: 3, backoffMs: [2, 10] };
// AI settings: file overrides env defaults; schema applies hard defaults. Tolerant.
function aiEnvDefaults() {
    return {
        anonymizeRequests: process.env.AI_ANONYMIZE_REQUESTS != null
            ? process.env.AI_ANONYMIZE_REQUESTS !== 'false'
            : undefined,
        anthropicModel: process.env.ANTHROPIC_MODEL ?? undefined,
        anthropicModelFast: process.env.ANTHROPIC_MODEL_FAST ?? undefined,
        geminiModel: process.env.GEMINI_MODEL ?? undefined,
        geminiModelFast: process.env.GEMINI_MODEL_FAST ?? undefined,
        geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK ?? undefined,
    };
}
const LEGACY_MODEL_KEYS = [
    'provider',
    'fallbackEnabled',
    'anthropicModel',
    'anthropicModelFast',
    'geminiModel',
    'geminiModelFast',
    'geminiModelFallback',
];
function hasLegacyModelOverride(raw) {
    return LEGACY_MODEL_KEYS.some((k) => raw[k] != null);
}
function dedupeSteps(arr) {
    const seen = new Set();
    return arr.filter((x) => {
        const k = `${x.provider}:${x.model}`;
        if (seen.has(k)) {
            return false;
        }
        seen.add(k);
        return true;
    });
}
// Build a cascade from the deprecated scalar fields so a pre-`cascades` ai.json
// keeps its old behavior: provider order honored, fallback toggled, Ollama tail
// appended. Used only when a file/env sets legacy fields but no explicit cascade.
function synthesizeCascades(s) {
    const anthroMain = { provider: 'anthropic', model: s.anthropicModel };
    const anthroFast = { provider: 'anthropic', model: s.anthropicModelFast };
    const gemMain = { provider: 'gemini', model: s.geminiModel };
    const gemMainFb = { provider: 'gemini', model: s.geminiModelFallback };
    const gemFast = { provider: 'gemini', model: s.geminiModelFast };
    const ollMain = { provider: 'ollama', model: 'qwen3:30b-a3b' };
    const ollFast = { provider: 'ollama', model: 'qwen3.5:9b' };
    const geminiFirst = s.provider === 'gemini';
    if (!s.fallbackEnabled) {
        return geminiFirst
            ? { main: dedupeSteps([gemMain, gemMainFb]), fast: dedupeSteps([gemFast]) }
            : { main: [anthroMain], fast: [anthroFast] };
    }
    return geminiFirst
        ? {
            main: dedupeSteps([gemMain, gemMainFb, anthroMain, ollMain]),
            fast: dedupeSteps([gemFast, anthroFast, ollFast]),
        }
        : {
            main: dedupeSteps([anthroMain, gemMain, gemMainFb, ollMain]),
            fast: dedupeSteps([anthroFast, gemFast, ollFast]),
        };
}
// Keep the deprecated scalar fields consistent with the active cascade so older
// consumers (e.g. apps reading `anthropicModel`) see the model the cascade uses.
function backfillLegacy(s) {
    const firstOf = (tier, p) => tier.find((x) => x.provider === p)?.model;
    return {
        ...s,
        anthropicModel: firstOf(s.cascades.main, 'anthropic') ?? s.anthropicModel,
        anthropicModelFast: firstOf(s.cascades.fast, 'anthropic') ?? s.anthropicModelFast,
        geminiModel: firstOf(s.cascades.main, 'gemini') ?? s.geminiModel,
        geminiModelFast: firstOf(s.cascades.fast, 'gemini') ?? s.geminiModelFast,
    };
}
// Parsed-settings memo keyed by ai.json mtime: avoids re-running zod (+ the
// back-compat reconciliation) on every call within a request. Invalidated by a
// file write (mtime changes) or _clearCache (tests / env changes).
let settingsMemo = null;
function readAiSettings() {
    const full = path_1.default.join(CONTROL_DIR(), 'ai.json');
    let mtimeMs = -1;
    try {
        mtimeMs = fs_1.default.statSync(full).mtimeMs;
    }
    catch {
        /* absent → sentinel -1 (env/defaults only) */
    }
    if (settingsMemo?.mtimeMs === mtimeMs) {
        return settingsMemo.value;
    }
    const env = aiEnvDefaults();
    const raw = (0, reader_1.readRaw)('ai.json', OPTIONAL_READ);
    const rawFile = raw ?? {};
    let settings = schema_1.AI_SETTINGS_SCHEMA.parse({ ...env, ...rawFile });
    // If the file predates `cascades` but set legacy model fields, derive a cascade
    // from them so behavior is preserved until the cascade is published explicitly.
    const explicitCascades = rawFile.cascades != null;
    if (!explicitCascades && (hasLegacyModelOverride(rawFile) || hasLegacyModelOverride(env))) {
        settings = { ...settings, cascades: synthesizeCascades(settings) };
    }
    settings = backfillLegacy(settings);
    // Memoize only evidence, not failure: when the file EXISTS but the tolerant read
    // could not produce it (torn, corrupt, unreadable), memoizing env/defaults under
    // the failed file's mtime would make a transient outage sticky — every later call
    // with the same mtime would serve the fallback without ever re-reading. An absent
    // file (sentinel mtime -1) is a stable deployment state and stays memoized.
    if (raw !== null || mtimeMs === -1) {
        settingsMemo = { mtimeMs, value: settings };
    }
    return settings;
}
/** Did the AI settings come from the published file or env/defaults? (drift signal) */
function aiConfigSource() {
    return (0, reader_1.readRaw)('ai.json', OPTIONAL_READ) != null ? 'file' : 'env-default';
}
/** The cross-app registry for the shell AppSwitcher (from control/apps.json). */
function readApps() {
    const file = (0, reader_1.readRaw)('apps.json', OPTIONAL_READ) ?? {};
    return schema_1.APPS_SCHEMA.parse(file).apps;
}
function readNotifySettings() {
    const file = (0, reader_1.readRaw)('notify.json', OPTIONAL_READ) ?? {};
    return schema_1.NOTIFY_SETTINGS_SCHEMA.parse(file);
}
// ── Writers (hub only) ────────────────────────────────────────────────────────
function publishAiSettings(s) {
    (0, writer_1.writeRaw)('ai.json', schema_1.AI_SETTINGS_SCHEMA.parse(s));
}
function publishNotifySettings(s) {
    (0, writer_1.writeRaw)('notify.json', schema_1.NOTIFY_SETTINGS_SCHEMA.parse(s));
}
/** Test/maintenance helper — clears the read caches and the parsed-settings memo. */
function _clearCache() {
    (0, reader_1.clearReadCache)();
    settingsMemo = null;
}
