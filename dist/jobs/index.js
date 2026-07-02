"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.backoffForAttempt = exports.MAX_BACKOFF_MS = exports.BASE_BACKOFF_MS = exports.HANDLER_TIMEOUT_ERROR = exports.LOCK_TIMEOUT_MS = exports.DEFAULT_MAX_ATTEMPTS = exports.runDurableJob = void 0;
// Durable-job runner: a storage-agnostic idempotent state machine for
// hub-dispatched jobs. Apps import `runDurableJob` + implement `JobRunStore`
// over their own job_runs table. Subpath import: `@niyi/platform/jobs`.
__exportStar(require("./types"), exports);
var runner_1 = require("./runner");
Object.defineProperty(exports, "runDurableJob", { enumerable: true, get: function () { return runner_1.runDurableJob; } });
Object.defineProperty(exports, "DEFAULT_MAX_ATTEMPTS", { enumerable: true, get: function () { return runner_1.DEFAULT_MAX_ATTEMPTS; } });
Object.defineProperty(exports, "LOCK_TIMEOUT_MS", { enumerable: true, get: function () { return runner_1.LOCK_TIMEOUT_MS; } });
var helpers_1 = require("./helpers");
Object.defineProperty(exports, "HANDLER_TIMEOUT_ERROR", { enumerable: true, get: function () { return helpers_1.HANDLER_TIMEOUT_ERROR; } });
Object.defineProperty(exports, "BASE_BACKOFF_MS", { enumerable: true, get: function () { return helpers_1.BASE_BACKOFF_MS; } });
Object.defineProperty(exports, "MAX_BACKOFF_MS", { enumerable: true, get: function () { return helpers_1.MAX_BACKOFF_MS; } });
Object.defineProperty(exports, "backoffForAttempt", { enumerable: true, get: function () { return helpers_1.backoffForAttempt; } });
