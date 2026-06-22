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
function withTimeout(fn, ms) {
    const ac = new AbortController();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`attempt timed out after ${ms}ms`));
        }, ms);
        fn(ac.signal).then((v) => {
            clearTimeout(timer);
            resolve(v);
        }, (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}
// Build the ordered, configured step list for a tier. An explicit `pref` provider
// is stably hoisted to the front; `only` restricts to a single provider (used by
// the historical single-provider `getProvider`).
function buildSteps(tier, pref, only) {
    let steps = (0, store_1.readAiSettings)().cascades[tier].filter((s) => (0, registry_1.getAdapter)(s.provider)?.configured());
    if (only)
        steps = steps.filter((s) => s.provider === only);
    if (pref) {
        const p = pref;
        steps = [...steps.filter((s) => s.provider === p), ...steps.filter((s) => s.provider !== p)];
    }
    return steps;
}
async function runCascade(tier, kind, req, pref, onModel, only) {
    const settings = (0, store_1.readAiSettings)();
    const steps = buildSteps(tier, pref, only);
    if (steps.length === 0)
        return null;
    const logger = (0, config_1.getLogger)();
    // Telemetry is read live (mirrors anonymizeRequests). Only build records when a
    // sink is installed AND logging is on — otherwise the cascade is unchanged.
    const telemetryOn = settings.logAiCalls && (0, telemetry_1.hasAiTelemetrySink)();
    const logPayloads = settings.logPayloads;
    const app = req.app || process.env.APP_NAME || 'unknown';
    const purpose = req.purpose || 'unknown';
    const userId = req.userId ?? null;
    // Anonymize ONCE, reused across all cloud attempts. Local (Ollama) steps keep the
    // original text — data never leaves the LAN, so masking would only cost fidelity.
    const anon = settings.anonymizeRequests ? (0, anonymize_1.createAnonymizer)() : null;
    const maskedPrompt = anon ? anon.mask(req.prompt) : req.prompt;
    const maskedSystem = anon && req.system != null ? anon.mask(req.system) : req.system;
    // Emit a record for this attempt. Best-effort: recordAiCall anonymizes the
    // payloads itself (idempotent) and never throws. We pass the masked prompt when
    // masking applied to this step, else the raw prompt (recordAiCall masks it anyway).
    const emit = (step, attemptIdx, status, ms, promptSent, responseText, usage, error) => {
        if (!telemetryOn)
            return;
        const rec = {
            id: (0, telemetry_1.ulid)(),
            ts: new Date().toISOString(),
            app,
            userId,
            purpose,
            caller: 'cascade',
            tier,
            provider: step.provider,
            model: step.model,
            attempt: attemptIdx,
            status,
            error: error ?? null,
            latencyMs: ms,
            ...(usage?.tokensIn != null ? { tokensIn: usage.tokensIn } : {}),
            ...(usage?.tokensOut != null ? { tokensOut: usage.tokensOut } : {}),
        };
        const cost = (0, models_1.estimateCostCents)(step.model, usage?.tokensIn, usage?.tokensOut);
        if (cost != null)
            rec.costCentsEst = cost;
        if (logPayloads) {
            rec.prompt = promptSent;
            if (responseText != null)
                rec.response = responseText;
        }
        (0, telemetry_1.recordAiCall)(rec);
    };
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const adapter = (0, registry_1.getAdapter)(step.provider);
        const useMask = anon != null && !adapter.local;
        const willFallback = i < steps.length - 1;
        const prompt = useMask ? maskedPrompt : req.prompt;
        const system = useMask ? maskedSystem : req.system;
        const startedAt = Date.now();
        try {
            const result = await withTimeout((signal) => {
                if (kind === 'structured') {
                    const r = req;
                    const attempt = {
                        prompt,
                        system,
                        maxTokens: r.maxTokens,
                        toolName: r.toolName,
                        toolDescription: r.toolDescription,
                        jsonSchema: r.jsonSchema,
                    };
                    return adapter.callStructured(step.model, attempt, signal);
                }
                const attempt = { prompt, system, maxTokens: req.maxTokens };
                return adapter.callText(step.model, attempt, signal);
            }, TIMEOUT_MS[step.provider]);
            const ms = Date.now() - startedAt;
            const out = result.content;
            if (out != null) {
                onModel(tier, step.model);
                logger.info({ tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms }, '[ai/cascade] answered');
                const restored = !useMask || !anon
                    ? out
                    : kind === 'structured'
                        ? anon.unmaskDeep(out)
                        : anon.unmask(out);
                // Log the response as text (stringify structured output). The masked prompt
                // that left the host (`prompt`) is what we record; recordAiCall masks again
                // (idempotent) for safety on the raw path.
                const responseText = typeof restored === 'string' ? restored : JSON.stringify(restored);
                emit(step, i + 1, 'ok', ms, prompt, responseText, result.usage);
                return restored;
            }
            logger.warn({ tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms, reason: 'empty', willFallback }, '[ai/cascade] empty response');
            emit(step, i + 1, 'empty', ms, prompt, null, result.usage);
        }
        catch (err) {
            const ms = Date.now() - startedAt;
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ err, tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms, willFallback }, '[ai/cascade] attempt failed');
            emit(step, i + 1, 'error', ms, prompt, null, undefined, msg);
        }
    }
    logger.warn({ tier, kind, attempts: steps.length }, '[ai/cascade] all steps failed');
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
    const firstStep = () => buildSteps('main', pref, only)[0] ?? buildSteps('fast', pref, only)[0];
    return {
        get kind() {
            return only ?? firstStep()?.provider ?? 'anthropic';
        },
        get label() {
            const k = only ?? firstStep()?.provider;
            return k ? (0, registry_1.getAdapter)(k).label : 'AI';
        },
        configured() {
            return buildSteps('main', pref, only).length > 0 || buildSteps('fast', pref, only).length > 0;
        },
        modelName(which = 'main') {
            return last[which] ?? buildSteps(which, pref, only)[0]?.model ?? '';
        },
        async generateStructured(req) {
            return (await runCascade(req.model ?? 'main', 'structured', req, pref, onModel, only));
        },
        async generateText(req) {
            return (await runCascade(req.model ?? 'main', 'text', req, pref, onModel, only));
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
/**
 * One-shot health/latency probe of a specific {provider, model} — backs the Hub's
 * per-step "Test" button. Sends a tiny text request and reports ok + round-trip ms.
 */
async function probeModel(provider, model, timeoutMs = 20000) {
    const adapter = (0, registry_1.getAdapter)(provider);
    if (!adapter)
        return { ok: false, ms: 0, error: `unknown provider '${provider}'` };
    if (!adapter.configured())
        return { ok: false, ms: 0, error: 'not configured (missing key/endpoint)' };
    const start = Date.now();
    try {
        const out = await withTimeout((signal) => adapter.callText(model, { prompt: 'Reply with exactly one word: ok', maxTokens: 8 }, signal), timeoutMs);
        const ms = Date.now() - start;
        return out.content != null ? { ok: true, ms } : { ok: false, ms, error: 'empty response' };
    }
    catch (e) {
        return { ok: false, ms: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
}
