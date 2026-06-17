"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyHubToken = verifyHubToken;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const store_1 = require("./store");
function b64urlDecode(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64urlJson(s) {
    try {
        return JSON.parse(b64urlDecode(s).toString('utf8'));
    }
    catch {
        return null;
    }
}
/**
 * Verify a hub-token: HS256 signature against SHARED_JWT_SECRET, `iss==='hub'`,
 * not expired, and jti not revoked. Returns the payload or null.
 */
function verifyHubToken(token) {
    if (!token)
        return null;
    const secret = config_1.keys.sharedJwtSecret();
    if (!secret)
        return null;
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = b64urlJson(headerB64);
    if (!header || header.alg !== 'HS256')
        return null;
    const expected = crypto_1.default
        .createHmac('sha256', secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest();
    const given = b64urlDecode(sigB64);
    if (expected.length !== given.length || !crypto_1.default.timingSafeEqual(expected, given))
        return null;
    const payload = b64urlJson(payloadB64);
    if (!payload || payload.iss !== 'hub')
        return null;
    if (payload.exp && Date.now() / 1000 > payload.exp)
        return null;
    if ((0, store_1.isRevoked)(payload.jti))
        return null;
    return payload;
}
