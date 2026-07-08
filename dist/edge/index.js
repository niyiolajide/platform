"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasPulseToken = hasPulseToken;
exports.pulseLoginRedirect = pulseLoginRedirect;
exports.pulseAuthGate = pulseAuthGate;
const server_1 = require("next/server");
const COOKIE = 'pulse-token';
function splitHostPort(value) {
    const lower = value.toLowerCase();
    const lastColon = lower.lastIndexOf(':');
    if (lastColon <= 0 || lower.includes(']')) {
        return { host: lower, port: '' };
    }
    return { host: lower.slice(0, lastColon), port: lower.slice(lastColon + 1) };
}
function sameRequestHost(left, right) {
    if (left === right) {
        return true;
    }
    const a = splitHostPort(left);
    const b = splitHostPort(right);
    if (a.port !== b.port) {
        return false;
    }
    const loopback = new Set(['localhost', '127.0.0.1', '::1']);
    return loopback.has(a.host) && loopback.has(b.host);
}
/** True if the `pulse-token` is present as a cookie or `Authorization: Bearer` header. */
function hasPulseToken(request) {
    return (Boolean(request.cookies.get(COOKIE)?.value) ||
        /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? ''));
}
/**
 * Builds the redirect to ControlPlane `/login` for an unauthenticated page request.
 * Behind the shared Tailscale proxy ControlPlane lives at the SAME origin root, so the
 * login URL is derived from the forwarded host/proto (edge can't read non-NEXT_PUBLIC
 * env at runtime). Falls back to the configured hub URL for direct/local access.
 * The `next` param bounces back to the original (basePath-aware, scheme-correct) URL.
 *
 * Shared primitive: used by `pulseAuthGate` and by apps with a custom gate model
 * (e.g. an allow-list + CSRF) that only need the redirect, not the full gate.
 */
function pulseLoginRedirect(request, opts = {}) {
    const { pathname } = request.nextUrl;
    const xfHost = request.headers.get('x-forwarded-host');
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const requestHost = request.headers.get('host') ?? request.nextUrl.host;
    const fwdHost = xfHost ?? requestHost;
    const fwdProto = forwardedProto ?? request.nextUrl.protocol.replace(':', '');
    // Next's standalone server can set self-referential x-forwarded-* headers for
    // direct local app-port requests. Those are not the shared ControlPlane proxy.
    const proxied = xfHost != null && !sameRequestHost(xfHost, requestHost);
    const hubBase = proxied
        ? `${fwdProto}://${fwdHost}`
        : opts.hubUrlFallback ??
            process.env.CONTROLPLANE_URL_PUBLIC ??
            process.env.NEXT_PUBLIC_CONTROLPLANE_URL ??
            'http://localhost:4000';
    const url = new URL('/login', hubBase);
    if (fwdHost != null) {
        const basePath = opts.basePath ?? request.nextUrl.basePath;
        url.searchParams.set('next', `${fwdProto}://${fwdHost}${basePath}${pathname}`);
    }
    return server_1.NextResponse.redirect(url);
}
/**
 * Returns a `NextResponse` to short-circuit the request, or `null` to continue.
 *
 * Usage in an app's middleware.ts:
 *   export function middleware(req: NextRequest) {
 *     return pulseAuthGate(req, { publicPrefixes: ['/api/health', '/_next', '/favicon'] })
 *       ?? NextResponse.next()
 *   }
 */
function pulseAuthGate(request, opts = {}) {
    const { pathname } = request.nextUrl;
    const method = request.method;
    const publicPrefixes = opts.publicPrefixes ?? [];
    if (publicPrefixes.some((p) => pathname.startsWith(p))) {
        return null;
    }
    const publicGetPrefixes = opts.publicGetPrefixes ?? [];
    if ((method === 'GET' || method === 'HEAD') && publicGetPrefixes.some((p) => pathname.startsWith(p))) {
        return null;
    }
    if (hasPulseToken(request)) {
        return null;
    }
    // API calls get a 401; page navigations redirect to ControlPlane login.
    if (pathname.startsWith('/api/')) {
        return server_1.NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return pulseLoginRedirect(request, opts);
}
