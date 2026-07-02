"use strict";
// Durable-job envelope types. The runner is storage-agnostic: an app supplies a
// JobRunStore (typically a thin adapter over a `job_runs` table shaped like
// JobRunRecord — see the RetirementPulse Prisma `JobRun` model) and
// `runDurableJob` drives the claim/retry/dead-letter state machine on top of
// it. Plain JSON/Date types only — no @prisma/client dependency.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DedupeConflictError = exports.DEDUPE_CONFLICT_CODE = void 0;
exports.isDedupeConflict = isDedupeConflict;
exports.DEDUPE_CONFLICT_CODE = 'DEDUPE_CONFLICT';
/** Store adapters throw this from `create` when the dedupeKey already exists. */
class DedupeConflictError extends Error {
    constructor(dedupeKey) {
        super(dedupeKey == null ? 'duplicate dedupe key' : `duplicate dedupe key ${dedupeKey}`);
        this.code = exports.DEDUPE_CONFLICT_CODE;
        this.name = 'DedupeConflictError';
    }
}
exports.DedupeConflictError = DedupeConflictError;
/**
 * True for a DedupeConflictError or any error carrying a unique-violation code.
 * Prisma's raw P2002 is accepted so a naive adapter that forwards
 * `prisma.jobRun.create` errors unchanged still dedupes correctly.
 */
function isDedupeConflict(err) {
    if (typeof err !== 'object' || err == null || !('code' in err)) {
        return false;
    }
    const code = err.code;
    return code === exports.DEDUPE_CONFLICT_CODE || code === 'P2002';
}
