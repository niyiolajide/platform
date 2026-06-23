import { NextResponse, type NextRequest } from 'next/server';
export interface PulseAuthGateOptions {
    /**
     * The app's Next.js basePath, e.g. '/vantage'. Used to build the basePath-aware
     * `next` return URL. Defaults to `request.nextUrl.basePath`.
     */
    basePath?: string;
    /** Path prefixes (as middleware sees them — basePath already stripped) that bypass auth for ALL methods. */
    publicPrefixes?: string[];
    /** Path prefixes public for GET/HEAD only (read-only public pages, e.g. shared detail pages). */
    publicGetPrefixes?: string[];
    /**
     * Hub origin to use when NOT behind the shared proxy (local/direct access).
     * Defaults to env CONTROLPLANE_URL_PUBLIC → NEXT_PUBLIC_CONTROLPLANE_URL → http://localhost:4000.
     * (Behind the Tailscale proxy ControlPlane is same-origin and derived from the request.)
     */
    hubUrlFallback?: string;
}
/** True if the `pulse-token` is present as a cookie or `Authorization: Bearer` header. */
export declare function hasPulseToken(request: NextRequest): boolean;
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
export declare function pulseLoginRedirect(request: NextRequest, opts?: Pick<PulseAuthGateOptions, 'basePath' | 'hubUrlFallback'>): NextResponse;
/**
 * Returns a `NextResponse` to short-circuit the request, or `null` to continue.
 *
 * Usage in an app's middleware.ts:
 *   export function middleware(req: NextRequest) {
 *     return pulseAuthGate(req, { publicPrefixes: ['/api/health', '/_next', '/favicon'] })
 *       ?? NextResponse.next()
 *   }
 */
export declare function pulseAuthGate(request: NextRequest, opts?: PulseAuthGateOptions): NextResponse | null;
