"use strict";
// Allowed model ids for the hub admin UI dropdowns. Not enforced at call time
// (the API accepts any string), but the UI offers these and validates against them.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODEL_PRICES = exports.AI_MODELS = void 0;
exports.priceFor = priceFor;
exports.estimateCostCents = estimateCostCents;
exports.AI_MODELS = {
    anthropic: [
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-haiku-4-5',
    ],
    // Ordered best → cheapest.
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    // Local models served by Ollama on media001 (on-LAN; no API key, no anonymization).
    ollama: ['qwen3:30b-a3b', 'qwen3.5:9b'],
};
// USD list prices as of 2026-06 (converted to cents/1M = USD/1M * 100).
// Conservative: where a model has tiered/context pricing we take the standard tier.
exports.MODEL_PRICES = [
    // Anthropic (Claude) — $/MTok: opus 5/25, sonnet 3/15, haiku 1/5.
    { model: 'claude-opus-4-8', per1MInCents: 500, per1MOutCents: 2500, since: '2026-01-01' },
    { model: 'claude-sonnet-4-6', per1MInCents: 300, per1MOutCents: 1500, since: '2026-01-01' },
    { model: 'claude-haiku-4-5', per1MInCents: 100, per1MOutCents: 500, since: '2026-01-01' },
    // Gemini (Google) — $/MTok (standard ≤200k context tier): pro 1.25/10,
    // flash 0.30/2.50, flash-lite 0.10/0.40, 2.0-flash 0.10/0.40.
    { model: 'gemini-2.5-pro', per1MInCents: 125, per1MOutCents: 1000, since: '2026-01-01' },
    { model: 'gemini-2.5-flash-lite', per1MInCents: 10, per1MOutCents: 40, since: '2026-01-01' },
    { model: 'gemini-2.5-flash', per1MInCents: 30, per1MOutCents: 250, since: '2026-01-01' },
    { model: 'gemini-2.0-flash', per1MInCents: 10, per1MOutCents: 40, since: '2026-01-01' },
    // Ollama (local, on-LAN) — no per-token cost.
    { model: 'qwen3:30b-a3b', per1MInCents: 0, per1MOutCents: 0, since: '2026-01-01' },
    { model: 'qwen3.5:9b', per1MInCents: 0, per1MOutCents: 0, since: '2026-01-01' },
];
/**
 * Resolve the price row for a model at a point in time. Exact id match wins; else
 * the longest id-prefix match (so dated variants like `…-20251001` map to the base
 * id). Among rows that match, the newest `since` not after `at` is chosen. Returns
 * null for unknown models (caller then omits cost).
 */
function priceFor(model, at = new Date()) {
    const atIso = at.toISOString().slice(0, 10);
    const candidates = exports.MODEL_PRICES.filter((p) => (model === p.model || model.startsWith(p.model)) && p.since <= atIso);
    if (candidates.length === 0)
        return null;
    // Prefer the most specific (longest) model match, then the newest since.
    candidates.sort((a, b) => b.model.length - a.model.length || (a.since < b.since ? 1 : -1));
    return candidates[0];
}
/**
 * Best-effort estimated cost in cents for a call. Returns undefined when the model
 * is unpriced or token counts are unavailable (cost is then omitted from the record).
 */
function estimateCostCents(model, tokensIn, tokensOut, at = new Date()) {
    const price = priceFor(model, at);
    if (!price)
        return undefined;
    if (tokensIn == null && tokensOut == null)
        return undefined;
    const inCents = ((tokensIn ?? 0) / 1000000) * price.per1MInCents;
    const outCents = ((tokensOut ?? 0) / 1000000) * price.per1MOutCents;
    return inCents + outCents;
}
