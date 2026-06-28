"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPulseToken = verifyPulseToken;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const store_1 = require("./store");
// ── Offline pulse-token verification ────────────────────────────────────────────
// Apps verify the shared pulse-token locally against ControlPlane's published RS256
// public key(s) (no network call) and additionally check the offline revocation
// denylist. This keeps SSO available even when ControlPlane is down, while still
// supporting revocation. Implemented with Node's built-in crypto so the package has
// no jsonwebtoken dependency and works inside Next standalone images.
//
// RS256-ONLY (Stage 4): ControlPlane is the sole minter via its RSA private key; apps
// verify with the published public key(s) and CANNOT forge. The header `kid` is matched
// against the published keys (or every key is tried when no kid is present) to support
// zero-downtime key rotation. HS256/shared-secret signing is fully retired.
//
// Claims enforced: `iss==='controlplane'`, RS256 signature, a REQUIRED `exp` (a token
// with no expiry is rejected — there must be no immortal tokens), `nbf` when present,
// an optional caller-supplied `expectedAud` (service/job tokens carry an `aud`), and
// the offline `jti` revocation denylist. A small clock-skew tolerance is allowed.
const CLOCK_SKEW_S = 30;
function b64urlDecode(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64urlJson(s) {
    try {
        const parsed = JSON.parse(b64urlDecode(s).toString('utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
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
            if (crypto_1.default.verify('RSA-SHA256', data, k.pem, sig)) {
                return true;
            }
        }
        catch {
            // malformed key PEM — skip
        }
    }
    return false;
}
/**
 * Verify a pulse-token: an RS256 signature against ControlPlane's published key(s),
 * `iss==='controlplane'`, a REQUIRED non-expired `exp`, `nbf` (when present), an
 * optional `expectedAud`, and `jti` not revoked. Returns the payload or null.
 */
function verifyPulseToken(token, opts = {}) {
    if (!token) {
        return null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }
    const [headerB64, payloadB64, sigB64] = parts;
    const header = b64urlJson(headerB64);
    if (!header) {
        return null;
    }
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = b64urlDecode(sigB64);
    // RS256-only (Stage 4): HS256 is retired — ControlPlane is the sole minter via its
    // private key; apps verify with the published public key(s) and cannot forge.
    if (header.alg !== 'RS256') {
        return null;
    }
    if (!verifyRs256(signingInput, sig, header.kid)) {
        return null;
    }
    const payload = parsePulsePayload(b64urlJson(payloadB64));
    if (payload?.iss !== 'controlplane') {
        return null;
    }
    const now = Date.now() / 1000;
    // Require an expiry — a token with no `exp` would be valid forever and is unprunable
    // from the revocation denylist; reject it outright. (Every ControlPlane minter sets exp.)
    // Strict (no skew): never extend a token's life past its stated expiry.
    if (typeof payload.exp !== 'number' || now > payload.exp) {
        return null;
    }
    // Enforce not-before when present (small skew tolerance for a just-minted token whose
    // nbf is marginally ahead of this host's clock).
    if (typeof payload.nbf === 'number' && now < payload.nbf - CLOCK_SKEW_S) {
        return null;
    }
    // Optional audience scoping — reject a token minted for a different service.
    if (opts.expectedAud) {
        const aud = payload.aud;
        const ok = Array.isArray(aud) ? aud.includes(opts.expectedAud) : aud === opts.expectedAud;
        if (!ok) {
            return null;
        }
    }
    if ((0, store_1.isRevoked)(payload.jti)) {
        return null;
    }
    return payload;
}
function parsePulsePayload(raw) {
    if (raw == null) {
        return null;
    }
    if (typeof raw.userId !== 'string' || typeof raw.email !== 'string' || typeof raw.iss !== 'string') {
        return null;
    }
    return raw;
}
