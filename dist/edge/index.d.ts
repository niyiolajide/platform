import { NextResponse, type NextRequest } from 'next/server';
export interface HubAuthGateOptions {
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
     * Defaults to env HUB_URL_PUBLIC → NEXT_PUBLIC_HUB_URL → http://localhost:4000.
     * (Behind the Tailscale proxy the hub is same-origin and derived from the request.)
     */
    hubUrlFallback?: string;
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
export declare function hubAuthGate(request: NextRequest, opts?: HubAuthGateOptions): NextResponse | null;
