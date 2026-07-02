// ── Reversible request anonymization ──────────────────────────────────────────
// Before any prompt/system text leaves the host for an external model API
// (Anthropic or Gemini), PII is replaced with stable placeholder tokens (e.g.
// [EMAIL_1], [PERSON_2]). The mapping is held in memory for the lifetime of a
// single request, so the model's response can be de-tokenized back to the real
// values — keeping PII off the wire while preserving output quality (digests /
// insights still name the real people/places).
//
// Monetary amounts are deliberately NOT tokenized: the model needs them to reason
// (compare, total, trend) for finance/health insights to be useful.
//
// Direct identifiers (email, phone, SSN, card, IBAN, IP, street address) are
// matched with deterministic, high-confidence patterns. Person names are matched
// against a curated allow-list of known people (the hub-managed `maskNames` in
// control/ai.json) rather than guessed: for a single-user system an explicit list
// is far more accurate than heuristic NER — it catches lone first names (which
// models miss) and never mis-flags brands/orgs (e.g. "Capital One", "GEICO") as
// people. Maintenance = add a person to `maskNames` (hub AI Logs → Names) when a
// new contact starts showing up in the data.

import { getLogger } from '../config'
import { readAiSettings } from '../control/store'

export type PiiCategory =
  | 'EMAIL'
  | 'PHONE'
  | 'SSN'
  | 'CARD'
  | 'IBAN'
  | 'IP'
  | 'ADDRESS'
  | 'PERSON'

const PII_CATEGORIES = 'EMAIL|PHONE|SSN|CARD|IBAN|IP|ADDRESS|PERSON'
// Tolerant of case + an underscore-or-space separator (model drift on restore).
const TOKEN_RE = new RegExp(`\\[\\s*(${PII_CATEGORIES})\\s*[_ ]\\s*(\\d+)\\s*\\]`, 'gi')
// Strict canonical shape — used to detect tokens left unrestored after unmask.
const CANONICAL_TOKEN_RE = new RegExp(`\\[(?:${PII_CATEGORIES})_\\d+\\]`, 'gi')

interface Detector {
  category: PiiCategory
  re: RegExp
  // Optional validator: return true to mask the match, false to leave it as-is.
  accept?: (match: string) => boolean
}

// ── Known people (the names that get masked) ──────────────────────────────────
// The allow-list of person names lives ONLY in the hub-managed `maskNames` in
// control/ai.json (grown from AI Logs triage) — deliberately NOT hardcoded here,
// since this repo is public. Entries are full names and/or lone first names, e.g.
// a household would list "Jane Anne Doe", "John Doe", "Jane". Both forms work.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Build a longest-first ("Jane Anne Doe" wins over a bare "Jane"), word-bounded,
// case-insensitive alternation over `names`. Null when the list is empty.
function buildNamesRe(names: string[]): RegExp | null {
  if (!names.length) {return null}
  return new RegExp(
    `\\b(?:${[...names]
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join('|')})\\b`,
    'gi',
  )
}

// The effective person regex = runtime `maskNames`. Compiled regex is cached by a
// stable key over the set, so it's rebuilt ONLY when the list changes —
// never per call (keeps masking O(text); no per-request recompile, see efficiency note).
let personCache: { key: string; re: RegExp | null } = { key: '\u0000uninit', re: null }
function personRegexFor(runtimeNames: string[]): RegExp | null {
  const all = [...new Set(runtimeNames)]
  const key = [...all].sort().join('\u0000')
  if (key !== personCache.key) {personCache = { key, re: buildNamesRe(all) }}
  return personCache.re
}

// Runtime PII config (names allow-list + warner deny-list) from control/ai.json —
// read offline + mtime-memoized by the control store, so this is cheap on the hot
// path. Guarded: NEVER throws — falls back to empty lists if unavailable (no person
// masking without the control bundle; direct-identifier detectors still run).
function readMaskConfig(): { maskNames: string[]; notPersonNames: string[] } {
  try {
    const s = readAiSettings()
    return { maskNames: s.maskNames, notPersonNames: s.notPersonNames }
  } catch {
    return { maskNames: [], notPersonNames: [] }
  }
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) {
      d *= 2
      if (d > 9) {d -= 9}
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

// Order matters: greedier / higher-confidence detectors run first so their text is
// already tokenized before later detectors (which never re-match a placeholder).
const DETECTORS: Detector[] = [
  {
    category: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: 'IP',
    // IPv4 only. (A prior IPv6 detector was removed: its `(?:hex:){2,7}hex` shape
    // matched clock times "12:34:56" and ratios "3:2:1" as IPs while MISSING the
    // common `::`-compressed form like "fe80::1" — net-negative. A correct IPv6
    // matcher needs the full canonical regex; not worth it for this data domain.)
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    category: 'SSN',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    category: 'CARD',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (m) => {
      const digits = m.replace(/\D/g, '')
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
    },
  },
  {
    category: 'IBAN',
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    category: 'PHONE',
    // Conservative US/intl: optional country code, optional area-code parens.
    // Bounded by non-digit/non-`$` on both sides so it can't match inside a longer
    // digit run (account/ref numbers) or swallow a bare numeric amount.
    re: /(?<![\d$])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g,
  },
  {
    category: 'ADDRESS',
    re: /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){0,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?/gi,
  },
  // PERSON is applied separately, AFTER these (so its text is tokenized last), from
  // the runtime allow-list (control maskNames) — see personRegexFor / mask().
]

// ── Recall-gap observability (does NOT mask) ──────────────────────────────────
// The `maskNames` allow-list is precise but low-recall: any person NOT on the list
// (a transfer counterparty, a doctor, a payee) passes to the cloud unmasked, and
// today that leak is silent. This warner makes it OBSERVABLE: after masking, it
// scans for Title-Case word runs (2–3 words) that survived — *possible* unmasked
// names — IF the same text also produced a real PII token (co-occurrence gate;
// see mask()). It never masks them (the allow-list owns precision); it only surfaces
// them so the leak rate is auditable and the allow-list can be grown from real data.
// Heuristic + Title-Case-only, so it UNDERCOUNTS — a floor on the leak, not a census.
// Separator is horizontal whitespace only ([ \t], not \s) so a run never spans a
// newline (which produced multi-line junk like "Family Support\n\nReturn").
const NAME_LIKE_RE = /\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,2}\b/g

// Title-Case runs that are NOT people — orgs, institutions, and UI labels seen in
// the platform's finance data. Extend as false alarms show up in the warner output.
const NOT_A_PERSON_SEED: string[] = [
  'Wells Fargo', 'Capital One', 'Charles Schwab', 'Rocket Mortgage', 'Discover Bank',
  'Ally Bank', 'Treasury Direct', 'Whole Foods', 'Bank Account', 'Brokerage Account',
  'Net Worth', 'Cash Reserve', 'Online Savings', 'Savings Account', 'Spending Account',
  'Health Savings', 'Active Cash', 'Spark Cash',
]

// Effective deny-list = seed ∪ runtime `notPersonNames` (hub-managed; grown when you
// "Ignore" a flagged candidate). Cached by key, same as the person regex.
let denyCache: { key: string; set: Set<string> } = { key: ' uninit', set: new Set() }
function denySetFor(runtimeDeny: string[]): Set<string> {
  const all = [...NOT_A_PERSON_SEED, ...runtimeDeny]
  const key = [...all].sort().join(' ')
  if (key !== denyCache.key) {denyCache = { key, set: new Set(all) }}
  return denyCache.set
}

function detectPossibleUnmaskedNames(masked: string, denySet: Set<string>): string[] {
  const hits = new Set<string>()
  for (const m of masked.matchAll(NAME_LIKE_RE)) {
    if (m[0].includes('[')) {continue} // never matches a placeholder, but be safe
    if (denySet.has(m[0])) {continue}
    hits.add(m[0])
  }
  return [...hits]
}

export interface Anonymizer {
  /** Replace PII in `text` with stable placeholder tokens. */
  mask(text: string): string
  /** Restore original values into `text` (typically the model's response). */
  unmask(text: string): string
  /** Recursively restore originals in every string value of a JSON-ish object. */
  unmaskDeep<T>(value: T): T
  /** Whether any PII was detected/replaced so far (useful for logging). */
  hasMappings(): boolean
  /**
   * Title-Case word runs that survived masking across all mask() calls on this
   * instance — *possible* person names the `maskNames` allow-list missed (and that
   * therefore went to the cloud unmasked). Observability for the allow-list recall
   * gap; the caller attaches these to telemetry for triage. Heuristic + Title-Case-
   * only, so it undercounts. Empty when nothing suspicious survived.
   */
  possibleUnmaskedNames(): string[]
}

interface AnonymizerState {
  originalToToken: Map<string, string>
  tokenToOriginal: Map<string, string>
  counters: Partial<Record<PiiCategory, number>>
  nameCandidates: Set<string>
  personRe: RegExp | null
  denySet: Set<string>
}

function tokenFor(state: AnonymizerState, category: PiiCategory, original: string): string {
  const existing = state.originalToToken.get(original)
  if (existing) {return existing}
  state.counters[category] = (state.counters[category] ?? 0) + 1
  const token = `[${category}_${state.counters[category]}]`
  state.originalToToken.set(original, token)
  state.tokenToOriginal.set(token, original)
  return token
}

function maskWithState(state: AnonymizerState, text: string): string {
  if (!text) {return text}
  let out = text
  for (const det of DETECTORS) {
    out = out.replace(det.re, (m) => {
      if (det.accept && !det.accept(m)) {return m}
      return tokenFor(state, det.category, m)
    })
  }
  if (state.personRe != null) {out = out.replace(state.personRe, (m) => tokenFor(state, 'PERSON', m))}
  const cand = CANONICAL_TOKEN_RE.test(out) ? detectPossibleUnmaskedNames(out, state.denySet) : []
  CANONICAL_TOKEN_RE.lastIndex = 0
  if (cand.length > 0) {
    cand.forEach((c) => state.nameCandidates.add(c))
    getLogger().info(
      { candidates: cand.slice(0, 20), count: cand.length },
      '[ai/anonymize] possible unmasked person name(s) left in prompt',
    )
  }
  return out
}

function unmaskWithState(state: AnonymizerState, text: string): string {
  if (!text || state.tokenToOriginal.size === 0) {return text}
  const restored = text.replace(TOKEN_RE, (full, cat: string, num: string) => {
    return state.tokenToOriginal.get(`[${cat.toUpperCase()}_${num}]`) ?? full
  })
  const leftover = restored.match(CANONICAL_TOKEN_RE)
  if (leftover != null) {
    getLogger().warn({ leftover: [...new Set(leftover)] }, '[ai/anonymize] unrestored PII placeholder(s) in model output')
  }
  return restored
}

function unmaskDeepValue(value: unknown, unmask: (text: string) => string): unknown {
  if (typeof value === 'string') {return unmask(value)}
  if (Array.isArray(value)) {return value.map((item) => unmaskDeepValue(item, unmask))}
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmaskDeepValue(item, unmask)]))
  }
  return value
}

/**
 * Create a per-request anonymizer. Mask the prompt and system with the SAME
 * instance so a value appearing in both maps to one consistent token, then unmask
 * the response with that same instance.
 */
export function createAnonymizer(): Anonymizer {
  const { maskNames, notPersonNames } = readMaskConfig()
  const state: AnonymizerState = {
    originalToToken: new Map<string, string>(),
    tokenToOriginal: new Map<string, string>(),
    counters: {},
    nameCandidates: new Set<string>(),
    personRe: personRegexFor(maskNames),
    denySet: denySetFor(notPersonNames),
  }

  const unmask = (text: string): string => unmaskWithState(state, text)
  return {
    mask: (text) => maskWithState(state, text),
    unmask,
    unmaskDeep: (value) => unmaskDeepValue(value, unmask) as typeof value,
    hasMappings: () => state.tokenToOriginal.size > 0,
    possibleUnmaskedNames: () => [...state.nameCandidates],
  }
}
