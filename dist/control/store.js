"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAiSettings = readAiSettings;
exports.aiConfigSource = aiConfigSource;
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
        anthropicModel: process.env.ANTHROPIC_MODEL || undefined,
        anthropicModelFast: process.env.ANTHROPIC_MODEL_FAST || undefined,
        geminiModel: process.env.GEMINI_MODEL || undefined,
        geminiModelFast: process.env.GEMINI_MODEL_FAST || undefined,
        geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK || undefined,
    };
}
function readAiSettings() {
    const env = aiEnvDefaults();
    const file = readRaw('ai.json') ?? {};
    // Drop undefined env entries so they don't clobber file/schema defaults.
    const envClean = Object.fromEntries(Object.entries(env).filter(([, v]) => v != null));
    return schema_1.AI_SETTINGS_SCHEMA.parse({ ...envClean, ...file });
}
/** Did the AI settings come from the published file or env/defaults? (drift signal) */
function aiConfigSource() {
    return readRaw('ai.json') ? 'file' : 'env-default';
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
}
