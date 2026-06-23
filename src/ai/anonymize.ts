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
// against a curated allow-list of known people (KNOWN_NAMES) rather than guessed:
// for a single-user system an explicit list is far more accurate than heuristic
// NER — it catches lone first names (which models miss) and never mis-flags
// brands/orgs (e.g. "Capital One", "GEICO") as people. Maintenance = add a person
// to KNOWN_NAMES when a new contact starts showing up in the data.

import { getLogger } from '../config'

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

// ── Known people (the ONLY names that get masked) ─────────────────────────────
// Seeded from names appearing in the user's connector data. Add household
// members / frequent contacts here; full names and lone first names both work.
const KNOWN_NAMES: string[] = [
  'Niyi Olajide',
  'Wasiu Olajide',
  'Nina Wang',
  'Zahrah',
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One alternation over all known names, longest-first so "Niyi Olajide" wins over
// a bare "Niyi". Case-insensitive + word-bounded. Null when the list is empty.
const KNOWN_NAMES_RE: RegExp | null = KNOWN_NAMES.length
  ? new RegExp(
      `\\b(?:${[...KNOWN_NAMES]
        .sort((a, b) => b.length - a.length)
        .map(escapeRe)
        .join('|')})\\b`,
      'gi',
    )
  : null

function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
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
  // Person names: ONLY those on the KNOWN_NAMES allow-list (no heuristic guessing).
  ...(KNOWN_NAMES_RE ? [{ category: 'PERSON' as const, re: KNOWN_NAMES_RE }] : []),
]

// ── Recall-gap observability (does NOT mask) ──────────────────────────────────
// The KNOWN_NAMES allow-list is precise but low-recall: any person NOT on the list
// (a transfer counterparty, a doctor, a payee) passes to the cloud unmasked, and
// today that leak is silent. This warner makes it OBSERVABLE: after masking, it
// scans for Title-Case word runs (2–3 words) that survived — *possible* unmasked
// names — and logs them at debug. It never masks them (the allow-list owns
// precision); it only surfaces them so the leak rate is auditable and KNOWN_NAMES
// can be grown from real data. Heuristic + Title-Case-only, so it UNDERCOUNTS
// (misses lowercase / single-word names) — it's a floor on the leak, not a census.
const NAME_LIKE_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g

// Title-Case runs that are NOT people — orgs, institutions, and UI labels seen in
// the platform's finance data. Extend as false alarms show up in the warner output.
const NOT_A_PERSON = new Set<string>([
  'Wells Fargo', 'Capital One', 'Charles Schwab', 'Rocket Mortgage', 'Discover Bank',
  'Ally Bank', 'Treasury Direct', 'Whole Foods', 'Bank Account', 'Brokerage Account',
  'Net Worth', 'Cash Reserve', 'Online Savings', 'Savings Account', 'Spending Account',
  'Health Savings', 'Active Cash', 'Spark Cash',
])

function detectPossibleUnmaskedNames(masked: string): string[] {
  const hits = new Set<string>()
  for (const m of masked.matchAll(NAME_LIKE_RE)) {
    if (m[0].includes('[')) continue // never matches a placeholder, but be safe
    if (NOT_A_PERSON.has(m[0])) continue
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
   * instance — *possible* person names the KNOWN_NAMES allow-list missed (and that
   * therefore went to the cloud unmasked). Observability for the allow-list recall
   * gap; the caller attaches these to telemetry for triage. Heuristic + Title-Case-
   * only, so it undercounts. Empty when nothing suspicious survived.
   */
  possibleUnmaskedNames(): string[]
}

/**
 * Create a per-request anonymizer. Mask the prompt and system with the SAME
 * instance so a value appearing in both maps to one consistent token, then unmask
 * the response with that same instance.
 */
export function createAnonymizer(): Anonymizer {
  const originalToToken = new Map<string, string>()
  const tokenToOriginal = new Map<string, string>()
  const counters: Record<string, number> = {}
  // Accumulates across mask() calls (prompt + system share one instance).
  const nameCandidates = new Set<string>()

  function tokenFor(category: PiiCategory, original: string): string {
    const existing = originalToToken.get(original)
    if (existing) return existing
    counters[category] = (counters[category] ?? 0) + 1
    const token = `[${category}_${counters[category]}]`
    originalToToken.set(original, token)
    tokenToOriginal.set(token, original)
    return token
  }

  function mask(text: string): string {
    if (!text) return text
    let out = text
    for (const det of DETECTORS) {
      out = out.replace(det.re, (m) => {
        if (det.accept && !det.accept(m)) return m
        return tokenFor(det.category, m)
      })
    }
    // Observability only — never mutates `out` (see warner note above). Record
    // candidates on the instance (for telemetry) and log them as an audit signal.
    const cand = detectPossibleUnmaskedNames(out)
    if (cand.length) {
      cand.forEach((c) => nameCandidates.add(c))
      // info, not warn: a signal to grow KNOWN_NAMES from, not an alert.
      getLogger().info(
        { candidates: cand.slice(0, 20), count: cand.length },
        '[ai/anonymize] possible unmasked person name(s) left in prompt',
      )
    }
    return out
  }

  function unmask(text: string): string {
    if (!text || tokenToOriginal.size === 0) return text
    // Tolerant restore: models sometimes echo a placeholder with different case or
    // a space instead of the underscore (e.g. "[person 1]"). Normalize to the
    // canonical token before lookup so PII is still reliably restored.
    const restored = text.replace(TOKEN_RE, (full, cat: string, num: string) => {
      const v = tokenToOriginal.get(`[${cat.toUpperCase()}_${num}]`)
      return v != null ? v : full
    })
    // Any placeholder-shaped string still present = a token the model invented or
    // mangled beyond recovery → a potential leak. Surface it rather than silently
    // shipping "[PERSON_2]" into a user-facing digest.
    const leftover = restored.match(CANONICAL_TOKEN_RE)
    if (leftover) {
      getLogger().warn(
        { leftover: [...new Set(leftover)] },
        '[ai/anonymize] unrestored PII placeholder(s) in model output',
      )
    }
    return restored
  }

  function unmaskDeep<T>(value: T): T {
    if (typeof value === 'string') return unmask(value) as unknown as T
    if (Array.isArray(value)) return value.map((v) => unmaskDeep(v)) as unknown as T
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = unmaskDeep(v)
      }
      return out as T
    }
    return value
  }

  return {
    mask,
    unmask,
    unmaskDeep,
    hasMappings: () => tokenToOriginal.size > 0,
    possibleUnmaskedNames: () => [...nameCandidates],
  }
}
