"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAiSettings = readAiSettings;
exports.aiConfigSource = aiConfigSource;
exports.readApps = readApps;
exports.readNotifySettings = readNotifySettings;
exports.readRevocations = readRevocations;
exports.isRevoked = isRevoked;
exports.publishAiSettings = publishAiSettings;
exports.publishNotifySettings = publishNotifySettings;
exports.publishRevocations = publishRevocations;
exports.revokeJti = revokeJti;
exports._clearCache = _clearCache;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const schema_1 = require("./schema");
// ── Control-bundle file-bus ───────────────────────────────────────────────────
// The hub publishes JSON to a shared volume (default /control); apps read it
// OFFLINE — no network call, so the hub being down never blocks an app. Reads are
// mtime-cached (cheap on the hot path, near-real-time after a hub edit). Writes are
// atomic (temp + rename) and only the hub mounts the dir read-write.
const CONTROL_DIR = () => process.env.CONTROL_DIR || '/control';
const cache = new Map();
/** Read + parse a control file, mtime-cached. Returns null if absent/unreadable. */
function readRaw(file) {
    const full = path_1.default.join(CONTROL_DIR(), file);
    let stat;
    try {
        stat = fs_1.default.statSync(full);
    }
    catch {
        return null;
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs)
        return hit.value;
    try {
        const value = JSON.parse(fs_1.default.readFileSync(full, 'utf8'));
        cache.set(file, { mtimeMs: stat.mtimeMs, value });
        return value;
    }
    catch (err) {
        (0, config_1.getLogger)().warn({ err, file }, '[control] failed to read/parse control file');
        return null;
    }
}
/** Atomic write of a control file (hub only). */
function writeRaw(file, value) {
    const dir = CONTROL_DIR();
    fs_1.default.mkdirSync(dir, { recursive: true });
    const full = path_1.default.join(dir, file);
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    fs_1.default.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs_1.default.renameSync(tmp, full);
    cache.delete(file);
}
// AI settings: file overrides env defaults; schema applies hard defaults. Tolerant.
function aiEnvDefaults() {
    return {
        anonymizeRequests: process.env.AI_ANONYMIZE_REQUESTS != null
            ? process.env.AI_ANONYMIZE_REQUESTS !== 'false'
            : undefined,
        anthropicModel: process.env.ANTHROPIC_MODEL || undefined,
        anthropicModelFast: process.env.ANTHROPIC_MODEL_FAST || undefined,
        geminiModel: process.env.GEMINI_MODEL || undefined,
        geminiModelFast: process.env.GEMINI_MODEL_FAST || undefined,
        geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK || undefined,
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
        if (seen.has(k))
            return false;
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
    if (settingsMemo && settingsMemo.mtimeMs === mtimeMs)
        return settingsMemo.value;
    const env = aiEnvDefaults();
    const rawFile = readRaw('ai.json') ?? {};
    // Drop undefined env entries so they don't clobber file/schema defaults.
    const envClean = Object.fromEntries(Object.entries(env).filter(([, v]) => v != null));
    let settings = schema_1.AI_SETTINGS_SCHEMA.parse({ ...envClean, ...rawFile });
    // If the file predates `cascades` but set legacy model fields, derive a cascade
    // from them so behavior is preserved until the cascade is published explicitly.
    const explicitCascades = rawFile.cascades != null;
    if (!explicitCascades && (hasLegacyModelOverride(rawFile) || hasLegacyModelOverride(envClean))) {
        settings = { ...settings, cascades: synthesizeCascades(settings) };
    }
    settings = backfillLegacy(settings);
    settingsMemo = { mtimeMs, value: settings };
    return settings;
}
/** Did the AI settings come from the published file or env/defaults? (drift signal) */
function aiConfigSource() {
    return readRaw('ai.json') ? 'file' : 'env-default';
}
/** The cross-app registry for the shell AppSwitcher (from control/apps.json). */
function readApps() {
    const file = readRaw('apps.json') ?? {};
    return schema_1.APPS_SCHEMA.parse(file).apps;
}
function readNotifySettings() {
    const file = readRaw('notify.json') ?? {};
    return schema_1.NOTIFY_SETTINGS_SCHEMA.parse(file);
}
function readRevocations() {
    const file = readRaw('revocations.json') ?? {};
    return schema_1.REVOCATIONS_SCHEMA.parse(file);
}
function isRevoked(jti) {
    if (!jti)
        return false;
    return readRevocations().revoked.some((r) => r.jti === jti);
}
// ── Writers (hub only) ────────────────────────────────────────────────────────
function publishAiSettings(s) {
    writeRaw('ai.json', schema_1.AI_SETTINGS_SCHEMA.parse(s));
}
function publishNotifySettings(s) {
    writeRaw('notify.json', schema_1.NOTIFY_SETTINGS_SCHEMA.parse(s));
}
/** Replace the revocation list, pruning entries whose token has already expired. */
function publishRevocations(r) {
    const now = Math.floor(Date.now() / 1000);
    const pruned = {
        schemaVersion: r.schemaVersion ?? 1,
        revoked: r.revoked.filter((e) => e.exp > now),
    };
    writeRaw('revocations.json', schema_1.REVOCATIONS_SCHEMA.parse(pruned));
}
/** Add a single jti to the revocation list (hub only). */
function revokeJti(jti, exp) {
    const cur = readRevocations();
    if (cur.revoked.some((e) => e.jti === jti))
        return;
    publishRevocations({ schemaVersion: cur.schemaVersion, revoked: [...cur.revoked, { jti, exp }] });
}
/** Test/maintenance helper — clears the mtime cache. */
function _clearCache() {
    cache.clear();
    settingsMemo = null;
}
