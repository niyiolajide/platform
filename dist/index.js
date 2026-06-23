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
exports.verifyPulseToken = exports._clearCache = exports.revokeJti = exports.publishRevocations = exports.publishNotifySettings = exports.publishAiSettings = exports.isRevoked = exports.readRevocations = exports.readNotifySettings = exports.REVOCATIONS_SCHEMA = exports.NOTIFY_SETTINGS_SCHEMA = exports.NOTIFY_CHANNEL = exports.keys = exports.getLogger = exports.configurePlatform = void 0;
// Top-level barrel. Prefer the subpath imports (`@niyi/platform/ai`, `/notify`,
// `/control`) in apps; this re-exports the common surface for convenience.
// Note: the AI settings symbols come via `./ai`; from `./control` we re-export
// only the non-AI surface to avoid duplicate-export conflicts.
var config_1 = require("./config");
Object.defineProperty(exports, "configurePlatform", { enumerable: true, get: function () { return config_1.configurePlatform; } });
Object.defineProperty(exports, "getLogger", { enumerable: true, get: function () { return config_1.getLogger; } });
Object.defineProperty(exports, "keys", { enumerable: true, get: function () { return config_1.keys; } });
__exportStar(require("./ai"), exports);
__exportStar(require("./notify"), exports);
var control_1 = require("./control");
Object.defineProperty(exports, "NOTIFY_CHANNEL", { enumerable: true, get: function () { return control_1.NOTIFY_CHANNEL; } });
Object.defineProperty(exports, "NOTIFY_SETTINGS_SCHEMA", { enumerable: true, get: function () { return control_1.NOTIFY_SETTINGS_SCHEMA; } });
Object.defineProperty(exports, "REVOCATIONS_SCHEMA", { enumerable: true, get: function () { return control_1.REVOCATIONS_SCHEMA; } });
Object.defineProperty(exports, "readNotifySettings", { enumerable: true, get: function () { return control_1.readNotifySettings; } });
Object.defineProperty(exports, "readRevocations", { enumerable: true, get: function () { return control_1.readRevocations; } });
Object.defineProperty(exports, "isRevoked", { enumerable: true, get: function () { return control_1.isRevoked; } });
Object.defineProperty(exports, "publishAiSettings", { enumerable: true, get: function () { return control_1.publishAiSettings; } });
Object.defineProperty(exports, "publishNotifySettings", { enumerable: true, get: function () { return control_1.publishNotifySettings; } });
Object.defineProperty(exports, "publishRevocations", { enumerable: true, get: function () { return control_1.publishRevocations; } });
Object.defineProperty(exports, "revokeJti", { enumerable: true, get: function () { return control_1.revokeJti; } });
Object.defineProperty(exports, "_clearCache", { enumerable: true, get: function () { return control_1._clearCache; } });
Object.defineProperty(exports, "verifyPulseToken", { enumerable: true, get: function () { return control_1.verifyPulseToken; } });
