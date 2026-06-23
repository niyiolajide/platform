export type PiiCategory = 'EMAIL' | 'PHONE' | 'SSN' | 'CARD' | 'IBAN' | 'IP' | 'ADDRESS' | 'PERSON';
export interface Anonymizer {
    /** Replace PII in `text` with stable placeholder tokens. */
    mask(text: string): string;
    /** Restore original values into `text` (typically the model's response). */
    unmask(text: string): string;
    /** Recursively restore originals in every string value of a JSON-ish object. */
    unmaskDeep<T>(value: T): T;
    /** Whether any PII was detected/replaced so far (useful for logging). */
    hasMappings(): boolean;
    /**
     * Title-Case word runs that survived masking across all mask() calls on this
     * instance — *possible* person names the KNOWN_NAMES allow-list missed (and that
     * therefore went to the cloud unmasked). Observability for the allow-list recall
     * gap; the caller attaches these to telemetry for triage. Heuristic + Title-Case-
     * only, so it undercounts. Empty when nothing suspicious survived.
     */
    possibleUnmaskedNames(): string[];
}
/**
 * Create a per-request anonymizer. Mask the prompt and system with the SAME
 * instance so a value appearing in both maps to one consistent token, then unmask
 * the response with that same instance.
 */
export declare function createAnonymizer(): Anonymizer;
