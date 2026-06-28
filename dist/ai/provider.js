"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_PROVIDERS = void 0;
exports.getProvider = getProvider;
exports.anyAiConfigured = anyAiConfigured;
exports.resolveAiProvider = resolveAiProvider;
exports.probeModel = probeModel;
const config_1 = require("../config");
const store_1 = require("../control/store");
const anonymize_1 = require("./anonymize");
const models_1 = require("./models");
const registry_1 = require("./registry");
const telemetry_1 = require("./telemetry");
// Per-attempt deadline so a hung call falls through to the next step. Ollama gets a
// wider budget for a possible cold model-load (mitigated by keep_alive pinning).
const TIMEOUT_MS = {
    gemini: 60000,
    anthropic: 60000,
    ollama: 180000,
};
async function withTimeout(fn, ms) {
    const ac = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`attempt timed out after ${ms}ms`));
        }, ms);
    });
    try {
        return await Promise.race([fn(ac.signal), timeout]);
    }
    finally {
        if (timer != null) {
            clearTimeout(timer);
        }
    }
}
// Build the ordered, configured step list for a tier. An explicit `pref` provider
// is stably hoisted to the front; `only` restricts to a single provider (used by
// the historical single-provider `getProvider`).
function buildSteps(tier, pref, only) {
    let steps = (0, store_1.readAiSettings)().cascades[tier].filter((s) => (0, registry_1.getAdapter)(s.provider).configured());
    if (only) {
        steps = steps.filter((s) => s.provider === only);
    }
    if (pref) {
        const p = pref;
        steps = [...steps.filter((s) => s.provider === p), ...steps.filter((s) => s.provider !== p)];
    }
    return steps;
}
function first(items) {
    const [value] = items;
    return value;
}
function makeTelemetryState(settings, tier, req, anon) {
    return {
        enabled: settings.logAiCalls && (0, telemetry_1.hasAiTelemetrySink)(),
        logPayloads: settings.logPayloads,
        app: req.app ?? process.env.APP_NAME ?? 'unknown',
        purpose: req.purpose ?? 'unknown',
        userId: req.userId ?? null,
        tier,
        anon,
    };
}
function emitAttempt(args) {
    const { telemetry, step, attempt, status, ms, prompt, response, usage, error } = args;
    if (!telemetry.enabled) {
        return;
    }
    const rec = {
        id: (0, telemetry_1.ulid)(), ts: new Date().toISOString(), app: telemetry.app, userId: telemetry.userId,
        purpose: telemetry.purpose, caller: 'cascade', tier: telemetry.tier, provider: step.provider,
        model: step.model, attempt, status, error: error ?? null, latencyMs: ms,
        ...(usage?.tokensIn != null ? { tokensIn: usage.tokensIn } : {}),
        ...(usage?.tokensOut != null ? { tokensOut: usage.tokensOut } : {}),
    };
    const cost = (0, models_1.estimateCostCents)(step.model, usage?.tokensIn, usage?.tokensOut);
    if (cost != null) {
        rec.costCentsEst = cost;
    }
    if (telemetry.logPayloads) {
        rec.prompt = prompt;
        if (response != null) {
            rec.response = response;
        }
    }
    const nameCandidates = telemetry.anon?.possibleUnmaskedNames() ?? [];
    if (nameCandidates.length > 0) {
        rec.unmaskedNameCandidates = nameCandidates;
    }
    (0, telemetry_1.recordAiCall)(rec);
}
function callStep(args) {
    const adapter = (0, registry_1.getAdapter)(args.step.provider);
    if (args.kind === 'structured') {
        const req = args.req;
        return adapter.callStructured(args.step.model, {
            prompt: args.prompt, system: args.system, maxTokens: req.maxTokens,
            toolName: req.toolName, toolDescription: req.toolDescription, jsonSchema: req.jsonSchema,
        }, args.signal);
    }
    return adapter.callText(args.step.model, { prompt: args.prompt, system: args.system, maxTokens: args.req.maxTokens }, args.signal);
}
function restoreOutput(kind, out, anon) {
    if (anon == null) {
        return out;
    }
    return kind === 'structured' ? anon.unmaskDeep(out) : anon.unmask(out);
}
async function runAttempt(args) {
    const startedAt = Date.now();
    try {
        const result = await withTimeout((signal) => callStep({ ...args, signal }), TIMEOUT_MS[args.step.provider]);
        const ms = Date.now() - startedAt;
        const out = result.content;
        if (out == null) {
            (0, config_1.getLogger)().warn({ tier: args.tier, kind: args.kind, provider: args.step.provider, model: args.step.model, attempt: args.attempt, ms, reason: 'empty', willFallback: args.willFallback }, '[ai/cascade] empty response');
            emitAttempt({ telemetry: args.telemetry, step: args.step, attempt: args.attempt, status: 'empty', ms, prompt: args.prompt, usage: result.usage });
            return null;
        }
        args.onModel(args.tier, args.step.model);
        (0, config_1.getLogger)().info({ tier: args.tier, kind: args.kind, provider: args.step.provider, model: args.step.model, attempt: args.attempt, ms }, '[ai/cascade] answered');
        const restored = restoreOutput(args.kind, out, args.anonForRestore);
        const response = typeof restored === 'string' ? restored : JSON.stringify(restored);
        emitAttempt({ telemetry: args.telemetry, step: args.step, attempt: args.attempt, status: 'ok', ms, prompt: args.prompt, response, usage: result.usage });
        return restored;
    }
    catch (err) {
        const ms = Date.now() - startedAt;
        const error = err instanceof Error ? err.message : String(err);
        (0, config_1.getLogger)().warn({ err, tier: args.tier, kind: args.kind, provider: args.step.provider, model: args.step.model, attempt: args.attempt, ms, willFallback: args.willFallback }, '[ai/cascade] attempt failed');
        emitAttempt({ telemetry: args.telemetry, step: args.step, attempt: args.attempt, status: 'error', ms, prompt: args.prompt, error });
        return null;
    }
}
async function runCascade(args) {
    const { tier, kind, req, pref, only, onModel } = args;
    const settings = (0, store_1.readAiSettings)();
    const steps = buildSteps(tier, pref, only);
    if (steps.length === 0) {
        return null;
    }
    // Anonymize ONCE, reused across all cloud attempts. Local (Ollama) steps keep the
    // original text — data never leaves the LAN, so masking would only cost fidelity.
    const anon = settings.anonymizeRequests ? (0, anonymize_1.createAnonymizer)() : null;
    const maskedPrompt = anon ? anon.mask(req.prompt) : req.prompt;
    const maskedSystem = anon && req.system != null ? anon.mask(req.system) : req.system;
    const telemetry = makeTelemetryState(settings, tier, req, anon);
    for (const [i, step] of steps.entries()) {
        const adapter = (0, registry_1.getAdapter)(step.provider);
        const useMask = anon != null && adapter.local !== true;
        const prompt = useMask ? maskedPrompt : req.prompt;
        const system = useMask ? maskedSystem : req.system;
        const out = await runAttempt({ tier, kind, req, step, attempt: i + 1, willFallback: i < steps.length - 1, prompt, system, telemetry, onModel, anonForRestore: useMask ? anon : null });
        if (out != null) {
            return out;
        }
    }
    (0, config_1.getLogger)().warn({ tier, kind, attempts: steps.length }, '[ai/cascade] all steps failed');
    return null;
}
// ── Facade ────────────────────────────────────────────────────────────────────
// Implements the historical AiProvider surface over the cascade. `last` is scoped
// to THIS facade instance (one per resolveAiProvider call), so modelName() reports
// the model that actually answered — no shared global state.
function makeProvider(pref, only) {
    const last = {};
    const onModel = (tier, model) => {
        last[tier] = model;
    };
    const firstStep = () => first(buildSteps('main', pref, only)) ?? first(buildSteps('fast', pref, only));
    return {
        get kind() {
            return only ?? firstStep()?.provider ?? 'anthropic';
        },
        get label() {
            const k = only ?? firstStep()?.provider;
            return k != null ? (0, registry_1.getAdapter)(k).label : 'AI';
        },
        configured() {
            return buildSteps('main', pref, only).length > 0 || buildSteps('fast', pref, only).length > 0;
        },
        modelName(which = 'main') {
            return last[which] ?? first(buildSteps(which, pref, only))?.model ?? '';
        },
        async generateStructured(req) {
            return (await runCascade({ tier: req.model ?? 'main', kind: 'structured', req, pref, onModel, only }));
        },
        async generateText(req) {
            return (await runCascade({ tier: req.model ?? 'main', kind: 'text', req, pref, onModel, only }));
        },
    };
}
// ── Public selection API (unchanged signatures) ───────────────────────────────
exports.AI_PROVIDERS = ['gemini', 'anthropic', 'ollama'].map((k) => ({ kind: k, label: registry_1.ADAPTERS[k].label }));
/** A single-provider view over the cascade (only that provider's steps). */
function getProvider(kind) {
    return makeProvider(null, kind);
}
function anyAiConfigured() {
    return Object.values(registry_1.ADAPTERS).some((a) => a.configured());
}
/**
 * Resolve the AI provider facade for this request. An explicit `pref` (e.g.
 * LifeOS's per-user synthesisProvider) is stably hoisted to the front of the
 * cascade; otherwise the hub-managed cascade order is used as-is. Returns null only
 * when NO step in either tier is configured (callers then use deterministic
 * non-AI fallbacks). Note: with a local Ollama endpoint configured, there is
 * effectively always a last-resort step, so null is rare.
 */
function resolveAiProvider(pref) {
    const p = makeProvider(pref);
    return p.configured() ? p : null;
}
function isProviderKind(provider) {
    return Object.prototype.hasOwnProperty.call(registry_1.ADAPTERS, provider);
}
/**
 * One-shot health/latency probe of a specific {provider, model} — backs the Hub's
 * per-step "Test" button. Sends a tiny text request and reports ok + round-trip ms.
 */
async function probeModel(provider, model, timeoutMs = 20000) {
    if (!isProviderKind(provider)) {
        return { ok: false, ms: 0, error: `unknown provider '${provider}'` };
    }
    const adapter = (0, registry_1.getAdapter)(provider);
    if (!adapter.configured()) {
        return { ok: false, ms: 0, error: 'not configured (missing key/endpoint)' };
    }
    const start = Date.now();
    try {
        const out = await withTimeout((signal) => adapter.callText(model, { prompt: 'Reply with exactly one word: ok', maxTokens: 8 }, signal), timeoutMs);
        const ms = Date.now() - start;
        if (out.content == null) {
            return { ok: false, ms, error: 'empty response' };
        }
        return { ok: true, ms };
    }
    catch (err) {
        return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
}
