"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasPulseToken = hasPulseToken;
exports.pulseLoginRedirect = pulseLoginRedirect;
exports.pulseAuthGate = pulseAuthGate;
const server_1 = require("next/server");
const COOKIE = 'pulse-token';
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
    const fwdHost = xfHost ?? request.headers.get('host');
    const fwdProto = forwardedProto ?? request.nextUrl.protocol.replace(':', '');
    const proxied = xfHost != null || forwardedProto != null;
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
