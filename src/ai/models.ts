// Allowed model ids for the hub admin UI dropdowns. Not enforced at call time
// (the API accepts any string), but the UI offers these and validates against them.

export const AI_MODELS = {
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
} as const

export type AnthropicModel = (typeof AI_MODELS.anthropic)[number]
export type GeminiModel = (typeof AI_MODELS.gemini)[number]
export type OllamaModel = (typeof AI_MODELS.ollama)[number]

// ── Dated/versioned price table (for telemetry cost estimation) ───────────────
// Best-effort, conservative input/output token prices in *cents per 1M tokens*.
// Each entry carries a `since` date so the table is auditable and can grow new
// dated rows as prices change (the most recent row whose `since` <= the call ts,
// matched by id, wins). Cost is labeled "estimated" at capture and is OMITTED for
// any model not listed here (we never guess a price). Local Ollama models are
// priced at 0 (on-LAN, no per-token cost). Matching is by exact id first, then by
// a prefix match (so e.g. `claude-haiku-4-5-20251001` resolves to `claude-haiku-4-5`).
export interface ModelPrice {
  /** Model id (or id prefix) the price applies to. */
  model: string
  /** Cents per 1,000,000 input tokens. */
  per1MInCents: number
  /** Cents per 1,000,000 output tokens. */
  per1MOutCents: number
  /** ISO date (YYYY-MM-DD) the price took effect — newest matching row wins. */
  since: string
}

// USD list prices as of 2026-06 (converted to cents/1M = USD/1M * 100).
// Conservative: where a model has tiered/context pricing we take the standard tier.
export const MODEL_PRICES: ModelPrice[] = [
  // Anthropic (Claude) — $/MTok: opus 15/75, sonnet 3/15, haiku 0.80/4.
  { model: 'claude-opus-4-8', per1MInCents: 1500, per1MOutCents: 7500, since: '2026-01-01' },
  { model: 'claude-sonnet-4-6', per1MInCents: 300, per1MOutCents: 1500, since: '2026-01-01' },
  { model: 'claude-haiku-4-5', per1MInCents: 80, per1MOutCents: 400, since: '2026-01-01' },
  // Gemini (Google) — $/MTok (standard ≤200k context tier): pro 1.25/10,
  // flash 0.30/2.50, flash-lite 0.10/0.40, 2.0-flash 0.10/0.40.
  { model: 'gemini-2.5-pro', per1MInCents: 125, per1MOutCents: 1000, since: '2026-01-01' },
  { model: 'gemini-2.5-flash-lite', per1MInCents: 10, per1MOutCents: 40, since: '2026-01-01' },
  { model: 'gemini-2.5-flash', per1MInCents: 30, per1MOutCents: 250, since: '2026-01-01' },
  { model: 'gemini-2.0-flash', per1MInCents: 10, per1MOutCents: 40, since: '2026-01-01' },
  // Ollama (local, on-LAN) — no per-token cost.
  { model: 'qwen3:30b-a3b', per1MInCents: 0, per1MOutCents: 0, since: '2026-01-01' },
  { model: 'qwen3.5:9b', per1MInCents: 0, per1MOutCents: 0, since: '2026-01-01' },
]

/**
 * Resolve the price row for a model at a point in time. Exact id match wins; else
 * the longest id-prefix match (so dated variants like `…-20251001` map to the base
 * id). Among rows that match, the newest `since` not after `at` is chosen. Returns
 * null for unknown models (caller then omits cost).
 */
export function priceFor(model: string, at: Date = new Date()): ModelPrice | null {
  const atIso = at.toISOString().slice(0, 10)
  const candidates = MODEL_PRICES.filter(
    (p) => (model === p.model || model.startsWith(p.model)) && p.since <= atIso,
  )
  if (candidates.length === 0) return null
  // Prefer the most specific (longest) model match, then the newest since.
  candidates.sort((a, b) => b.model.length - a.model.length || (a.since < b.since ? 1 : -1))
  return candidates[0]
}

/**
 * Best-effort estimated cost in cents for a call. Returns undefined when the model
 * is unpriced or token counts are unavailable (cost is then omitted from the record).
 */
export function estimateCostCents(
  model: string,
  tokensIn: number | undefined,
  tokensOut: number | undefined,
  at: Date = new Date(),
): number | undefined {
  const price = priceFor(model, at)
  if (!price) return undefined
  if (tokensIn == null && tokensOut == null) return undefined
  const inCents = ((tokensIn ?? 0) / 1_000_000) * price.per1MInCents
  const outCents = ((tokensOut ?? 0) / 1_000_000) * price.per1MOutCents
  return inCents + outCents
}
