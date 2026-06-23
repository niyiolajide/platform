import { NextResponse, type NextRequest } from 'next/server'

// Edge-safe auth gate for the single-origin platform. Imports ONLY `next/server`
// (no node:crypto) so it runs in the middleware/edge runtime. The gate
// PRESENCE-CHECKS the hub-token; full RS256 verification stays in route handlers
// and getCurrentUser (Node), where every app already does it. One gate, used by
// every app's middleware, replaces the per-app drift.

export interface HubAuthGateOptions {
  /**
   * The app's Next.js basePath, e.g. '/vantage'. Used to build the basePath-aware
   * `next` return URL. Defaults to `request.nextUrl.basePath`.
   */
  basePath?: string
  /** Path prefixes (as middleware sees them — basePath already stripped) that bypass auth for ALL methods. */
  publicPrefixes?: string[]
  /** Path prefixes public for GET/HEAD only (read-only public pages, e.g. shared detail pages). */
  publicGetPrefixes?: string[]
  /**
   * Hub origin to use when NOT behind the shared proxy (local/direct access).
   * Defaults to env HUB_URL_PUBLIC → NEXT_PUBLIC_HUB_URL → http://localhost:4000.
   * (Behind the Tailscale proxy the hub is same-origin and derived from the request.)
   */
  hubUrlFallback?: string
}

const COOKIE = 'hub-token'

/**
 * Returns a `NextResponse` to short-circuit the request, or `null` to continue.
 *
 * Usage in an app's middleware.ts:
 *   export function middleware(req: NextRequest) {
 *     return hubAuthGate(req, { publicPrefixes: ['/api/health', '/_next', '/favicon'] })
 *       ?? NextResponse.next()
 *   }
 */
export function hubAuthGate(request: NextRequest, opts: HubAuthGateOptions = {}): NextResponse | null {
  const { pathname } = request.nextUrl
  const method = request.method

  const publicPrefixes = opts.publicPrefixes ?? []
  if (publicPrefixes.some((p) => pathname.startsWith(p))) return null

  const publicGetPrefixes = opts.publicGetPrefixes ?? []
  if ((method === 'GET' || method === 'HEAD') && publicGetPrefixes.some((p) => pathname.startsWith(p))) {
    return null
  }

  const hasToken =
    Boolean(request.cookies.get(COOKIE)?.value) ||
    /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? '')
  if (hasToken) return null

  // API calls get a 401; page navigations redirect to the hub login.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Behind the shared Tailscale proxy the hub lives at the SAME origin root, so
  // derive the login URL from the forwarded host/proto (edge can't read non-NEXT_PUBLIC
  // env at runtime). Fall back to the configured hub URL for direct/local access.
  const xfHost = request.headers.get('x-forwarded-host')
  const fwdHost = xfHost || request.headers.get('host')
  const fwdProto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '')
  const proxied = Boolean(xfHost || request.headers.get('x-forwarded-proto'))

  const hubBase = proxied
    ? `${fwdProto}://${fwdHost}`
    : opts.hubUrlFallback ||
      process.env.HUB_URL_PUBLIC ||
      process.env.NEXT_PUBLIC_HUB_URL ||
      'http://localhost:4000'

  const url = new URL('/login', hubBase)
  if (fwdHost) {
    const basePath = opts.basePath ?? request.nextUrl.basePath ?? ''
    url.searchParams.set('next', `${fwdProto}://${fwdHost}${basePath}${pathname}`)
  }
  return NextResponse.redirect(url)
}
