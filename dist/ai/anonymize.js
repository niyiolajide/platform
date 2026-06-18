"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAnonymizer = createAnonymizer;
// ── Known people (the ONLY names that get masked) ─────────────────────────────
// Seeded from names appearing in the user's connector data. Add household
// members / frequent contacts here; full names and lone first names both work.
const KNOWN_NAMES = [
    'Niyi Olajide',
    'Wasiu Olajide',
    'Nina Wang',
    'Zahrah',
];
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// One alternation over all known names, longest-first so "Niyi Olajide" wins over
// a bare "Niyi". Case-insensitive + word-bounded. Null when the list is empty.
const KNOWN_NAMES_RE = KNOWN_NAMES.length
    ? new RegExp(`\\b(?:${[...KNOWN_NAMES]
        .sort((a, b) => b.length - a.length)
        .map(escapeRe)
        .join('|')})\\b`, 'gi')
    : null;
function luhnValid(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (alt) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
        alt = !alt;
    }
    return sum % 10 === 0;
}
// Order matters: greedier / higher-confidence detectors run first so their text is
// already tokenized before later detectors (which never re-match a placeholder).
const DETECTORS = [
    {
        category: 'EMAIL',
        re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    },
    {
        category: 'IP',
        // IPv4
        re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    },
    {
        category: 'IP',
        // IPv6 (compressed forms not exhaustively covered; at least 3 hextet groups)
        re: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g,
    },
    {
        category: 'SSN',
        re: /\b\d{3}-\d{2}-\d{4}\b/g,
    },
    {
        category: 'CARD',
        re: /\b(?:\d[ -]?){13,19}\b/g,
        accept: (m) => {
            const digits = m.replace(/\D/g, '');
            return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
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
    ...(KNOWN_NAMES_RE ? [{ category: 'PERSON', re: KNOWN_NAMES_RE }] : []),
];
/**
 * Create a per-request anonymizer. Mask the prompt and system with the SAME
 * instance so a value appearing in both maps to one consistent token, then unmask
 * the response with that same instance.
 */
function createAnonymizer() {
    const originalToToken = new Map();
    const tokenToOriginal = new Map();
    const counters = {};
    function tokenFor(category, original) {
        const existing = originalToToken.get(original);
        if (existing)
            return existing;
        counters[category] = (counters[category] ?? 0) + 1;
        const token = `[${category}_${counters[category]}]`;
        originalToToken.set(original, token);
        tokenToOriginal.set(token, original);
        return token;
    }
    function mask(text) {
        if (!text)
            return text;
        let out = text;
        for (const det of DETECTORS) {
            out = out.replace(det.re, (m) => {
                if (det.accept && !det.accept(m))
                    return m;
                return tokenFor(det.category, m);
            });
        }
        return out;
    }
    function unmask(text) {
        if (!text || tokenToOriginal.size === 0)
            return text;
        return text.replace(/\[(?:EMAIL|PHONE|SSN|CARD|IBAN|IP|ADDRESS|PERSON)_\d+\]/g, (tok) => tokenToOriginal.has(tok) ? tokenToOriginal.get(tok) : tok);
    }
    function unmaskDeep(value) {
        if (typeof value === 'string')
            return unmask(value);
        if (Array.isArray(value))
            return value.map((v) => unmaskDeep(v));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = unmaskDeep(v);
            }
            return out;
        }
        return value;
    }
    return {
        mask,
        unmask,
        unmaskDeep,
        hasMappings: () => tokenToOriginal.size > 0,
    };
}
