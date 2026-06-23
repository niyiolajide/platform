"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hubAuthGate = hubAuthGate;
const server_1 = require("next/server");
const COOKIE = 'hub-token';
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
    const hasToken = Boolean(request.cookies.get(COOKIE)?.value) ||
        /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? '');
    if (hasToken)
        return null;
    // API calls get a 401; page navigations redirect to the hub login.
    if (pathname.startsWith('/api/')) {
        return server_1.NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Behind the shared Tailscale proxy the hub lives at the SAME origin root, so
    // derive the login URL from the forwarded host/proto (edge can't read non-NEXT_PUBLIC
    // env at runtime). Fall back to the configured hub URL for direct/local access.
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
