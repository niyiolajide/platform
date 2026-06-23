"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasHubToken = hasHubToken;
exports.hubLoginRedirect = hubLoginRedirect;
exports.hubAuthGate = hubAuthGate;
const server_1 = require("next/server");
const COOKIE = 'hub-token';
/** True if the `hub-token` is present as a cookie or `Authorization: Bearer` header. */
function hasHubToken(request) {
    return (Boolean(request.cookies.get(COOKIE)?.value) ||
        /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? ''));
}
/**
 * Builds the redirect to the hub `/login` for an unauthenticated page request.
 * Behind the shared Tailscale proxy the hub lives at the SAME origin root, so the
 * login URL is derived from the forwarded host/proto (edge can't read non-NEXT_PUBLIC
 * env at runtime). Falls back to the configured hub URL for direct/local access.
 * The `next` param bounces back to the original (basePath-aware, scheme-correct) URL.
 *
 * Shared primitive: used by `hubAuthGate` and by apps with a custom gate model
 * (e.g. an allow-list + CSRF) that only need the redirect, not the full gate.
 */
function hubLoginRedirect(request, opts = {}) {
    const { pathname } = request.nextUrl;
    const xfHost = request.headers.get('x-forwarded-host');
    const fwdHost = xfHost || request.headers.get('host');
    const fwdProto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
    const proxied = Boolean(xfHost || request.headers.get('x-forwarded-proto'));
    const hubBase = proxied
        ? `${fwdProto}://${fwdHost}`
        : opts.hubUrlFallback ||
            process.env.HUB_URL_PUBLIC ||
            process.env.NEXT_PUBLIC_HUB_URL ||
            'http://localhost:4000';
    const url = new URL('/login', hubBase);
    if (fwdHost) {
        const basePath = opts.basePath ?? request.nextUrl.basePath ?? '';
        url.searchParams.set('next', `${fwdProto}://${fwdHost}${basePath}${pathname}`);
    }
    return server_1.NextResponse.redirect(url);
}
/**
 * Returns a `NextResponse` to short-circuit the request, or `null` to continue.
 *
 * Usage in an app's middleware.ts:
 *   export function middleware(req: NextRequest) {
 *     return hubAuthGate(req, { publicPrefixes: ['/api/health', '/_next', '/favicon'] })
 *       ?? NextResponse.next()
 *   }
 */
function hubAuthGate(request, opts = {}) {
    const { pathname } = request.nextUrl;
    const method = request.method;
    const publicPrefixes = opts.publicPrefixes ?? [];
    if (publicPrefixes.some((p) => pathname.startsWith(p)))
        return null;
    const publicGetPrefixes = opts.publicGetPrefixes ?? [];
    if ((method === 'GET' || method === 'HEAD') && publicGetPrefixes.some((p) => pathname.startsWith(p))) {
        return null;
    }
    if (hasHubToken(request))
        return null;
    // API calls get a 401; page navigations redirect to the hub login.
    if (pathname.startsWith('/api/')) {
        return server_1.NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return hubLoginRedirect(request, opts);
}
