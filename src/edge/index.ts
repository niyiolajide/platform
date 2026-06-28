import { NextResponse, type NextRequest } from 'next/server'

// Edge-safe auth gate for the single-origin platform. Imports ONLY `next/server`
// (no node:crypto) so it runs in the middleware/edge runtime. The gate
// PRESENCE-CHECKS the pulse-token; full RS256 verification stays in route handlers
// and getCurrentUser (Node), where every app already does it. One gate, used by
// every app's middleware, replaces the per-app drift.

export interface PulseAuthGateOptions {
  /**
   * The app's Next.js basePath, e.g. '/finpulse'. Used to build the basePath-aware
   * `next` return URL. Defaults to `request.nextUrl.basePath`.
   */
  basePath?: string
  /** Path prefixes (as middleware sees them — basePath already stripped) that bypass auth for ALL methods. */
  publicPrefixes?: string[]
  /** Path prefixes public for GET/HEAD only (read-only public pages, e.g. shared detail pages). */
  publicGetPrefixes?: string[]
  /**
   * Hub origin to use when NOT behind the shared proxy (local/direct access).
   * Defaults to env CONTROLPLANE_URL_PUBLIC → NEXT_PUBLIC_CONTROLPLANE_URL → http://localhost:4000.
   * (Behind the Tailscale proxy ControlPlane is same-origin and derived from the request.)
   */
  hubUrlFallback?: string
}

const COOKIE = 'pulse-token'

/** True if the `pulse-token` is present as a cookie or `Authorization: Bearer` header. */
export function hasPulseToken(request: NextRequest): boolean {
  return (
    Boolean(request.cookies.get(COOKIE)?.value) ||
    /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? '')
  )
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
export function pulseLoginRedirect(
  request: NextRequest,
  opts: Pick<PulseAuthGateOptions, 'basePath' | 'hubUrlFallback'> = {},
): NextResponse {
  const { pathname } = request.nextUrl
  const xfHost = request.headers.get('x-forwarded-host')
  const fwdHost = xfHost || request.headers.get('host')
  const fwdProto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '')
  const proxied = Boolean(xfHost || request.headers.get('x-forwarded-proto'))

  const hubBase = proxied
    ? `${fwdProto}://${fwdHost}`
    : opts.hubUrlFallback ||
      process.env.CONTROLPLANE_URL_PUBLIC ||
      process.env.NEXT_PUBLIC_CONTROLPLANE_URL ||
      'http://localhost:4000'

  const url = new URL('/login', hubBase)
  if (fwdHost) {
    const basePath = opts.basePath ?? request.nextUrl.basePath ?? ''
    url.searchParams.set('next', `${fwdProto}://${fwdHost}${basePath}${pathname}`)
  }
  return NextResponse.redirect(url)
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
export function pulseAuthGate(request: NextRequest, opts: PulseAuthGateOptions = {}): NextResponse | null {
  const { pathname } = request.nextUrl
  const method = request.method

  const publicPrefixes = opts.publicPrefixes ?? []
  if (publicPrefixes.some((p) => pathname.startsWith(p))) return null

  const publicGetPrefixes = opts.publicGetPrefixes ?? []
  if ((method === 'GET' || method === 'HEAD') && publicGetPrefixes.some((p) => pathname.startsWith(p))) {
    return null
  }

  if (hasPulseToken(request)) return null

  // API calls get a 401; page navigations redirect to ControlPlane login.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return pulseLoginRedirect(request, opts)
}
