"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_PROVIDERS = void 0;
exports.getProvider = getProvider;
exports.anyAiConfigured = anyAiConfigured;
exports.resolveAiProvider = resolveAiProvider;
const config_1 = require("../config");
const store_1 = require("../control/store");
const anonymize_1 = require("./anonymize");
const registry_1 = require("./registry");
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
    // Anonymize ONCE, reused across all cloud attempts. Local (Ollama) steps keep the
    // original text — data never leaves the LAN, so masking would only cost fidelity.
    const anon = settings.anonymizeRequests ? (0, anonymize_1.createAnonymizer)() : null;
    const maskedPrompt = anon ? anon.mask(req.prompt) : req.prompt;
    const maskedSystem = anon && req.system != null ? anon.mask(req.system) : req.system;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const adapter = (0, registry_1.getAdapter)(step.provider);
        const useMask = anon != null && !adapter.local;
        const willFallback = i < steps.length - 1;
        const prompt = useMask ? maskedPrompt : req.prompt;
        const system = useMask ? maskedSystem : req.system;
        const startedAt = Date.now();
        try {
            const out = await withTimeout((signal) => {
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
            if (out != null) {
                onModel(tier, step.model);
                logger.info({ tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms }, '[ai/cascade] answered');
                if (!useMask || !anon)
                    return out;
                return kind === 'structured'
                    ? anon.unmaskDeep(out)
                    : anon.unmask(out);
            }
            logger.warn({ tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms, reason: 'empty', willFallback }, '[ai/cascade] empty response');
        }
        catch (err) {
            logger.warn({ err, tier, kind, provider: step.provider, model: step.model, attempt: i + 1, ms: Date.now() - startedAt, willFallback }, '[ai/cascade] attempt failed');
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
