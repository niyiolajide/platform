"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPulseToken = verifyPulseToken;
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
 * Verify an RS256 signature against the published hub public key(s). When a `kid`
 * is present only the matching key is tried; otherwise every published key is tried
 * (so rotation never locks anyone out). Returns true if any candidate verifies.
 */
function verifyRs256(signingInput, sig, kid) {
    const all = config_1.keys.pulsePublicKeys();
    const candidates = kid ? all.filter((k) => k.kid === kid) : all;
    // If a kid was supplied but doesn't match any known key, fall back to trying all
    // (tolerates a token minted under a key not yet in this app's env).
    const toTry = candidates.length > 0 ? candidates : all;
    const data = Buffer.from(signingInput);
    for (const k of toTry) {
        try {
            if (crypto_1.default.verify('RSA-SHA256', data, k.pem, sig))
                return true;
        }
        catch {
            // malformed key PEM — skip
        }
    }
    return false;
}
/**
 * Verify a pulse-token: an RS256 (asymmetric) OR HS256 (legacy shared-secret)
 * signature, plus `iss==='hub'`, not expired, and jti not revoked. Returns the
 * payload or null.
 */
function verifyPulseToken(token) {
    if (!token)
        return null;
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = b64urlJson(headerB64);
    if (!header)
        return null;
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = b64urlDecode(sigB64);
    // RS256-only (Stage 4): HS256 is retired — ControlPlane is the sole minter via its
    // private key; apps verify with the published public key(s) and cannot forge.
    if (header.alg !== 'RS256')
        return null;
    if (!verifyRs256(signingInput, sig, header.kid))
        return null;
    const payload = b64urlJson(payloadB64);
    if (!payload || payload.iss !== 'controlplane')
        return null;
    if (payload.exp && Date.now() / 1000 > payload.exp)
        return null;
    if ((0, store_1.isRevoked)(payload.jti))
        return null;
    return payload;
}
