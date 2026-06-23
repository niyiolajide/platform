import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { pulseAuthGate, pulseLoginRedirect, hasPulseToken, type PulseAuthGateOptions } from '../src/edge'

function makeReq(
  path: string,
  o: { method?: string; cookie?: string; bearer?: string; host?: string; proto?: string } = {},
) {
  const headers = new Headers()
  if (o.cookie) headers.set('cookie', `pulse-token=${o.cookie}`)
  if (o.bearer) headers.set('authorization', `Bearer ${o.bearer}`)
  if (o.host) headers.set('x-forwarded-host', o.host)
  if (o.proto) headers.set('x-forwarded-proto', o.proto)
  return new NextRequest(`https://backend.internal${path}`, { method: o.method ?? 'GET', headers })
}

const PROXY = { host: 'media002.tailc29663.ts.net', proto: 'https' }
const opts: PulseAuthGateOptions = {
  basePath: '/vantage',
  publicPrefixes: ['/api/health', '/_next', '/favicon'],
  publicGetPrefixes: ['/wisdom/'],
}

describe('pulseAuthGate', () => {
  it('bypasses public prefixes (all methods)', () => {
    expect(pulseAuthGate(makeReq('/api/health', PROXY), opts)).toBeNull()
    expect(pulseAuthGate(makeReq('/_next/static/x.js', PROXY), opts)).toBeNull()
  })

  it('bypasses public GET prefixes only for GET/HEAD', () => {
    expect(pulseAuthGate(makeReq('/wisdom/seneca-1', { ...PROXY, method: 'GET' }), opts)).toBeNull()
    // a mutation to the same prefix must NOT bypass
    expect(pulseAuthGate(makeReq('/wisdom/seneca-1', { ...PROXY, method: 'POST' }), opts)).not.toBeNull()
  })

  it('passes when a pulse-token cookie is present', () => {
    expect(pulseAuthGate(makeReq('/dashboard', { ...PROXY, cookie: 'abc.def.ghi' }), opts)).toBeNull()
  })

  it('passes when a Bearer token is present', () => {
    expect(pulseAuthGate(makeReq('/dashboard', { ...PROXY, bearer: 'abc.def.ghi' }), opts)).toBeNull()
  })

  it('returns 401 JSON for unauthenticated /api/*', () => {
    const res = pulseAuthGate(makeReq('/api/transactions', PROXY), opts)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('redirects unauthenticated pages to the same-origin hub login with a basePath-aware next', () => {
    const res = pulseAuthGate(makeReq('/dashboard', PROXY), opts)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(307)
    const loc = res!.headers.get('location')!
    const u = new URL(loc)
    expect(u.origin).toBe('https://media002.tailc29663.ts.net')
    expect(u.pathname).toBe('/login')
    expect(u.searchParams.get('next')).toBe('https://media002.tailc29663.ts.net/vantage/dashboard')
  })

  it('falls back to the configured hub URL when not behind a proxy', () => {
    // no x-forwarded-* headers => not proxied
    const res = pulseAuthGate(makeReq('/dashboard'), { ...opts, hubUrlFallback: 'http://localhost:4000' })
    expect(res!.status).toBe(307)
    expect(res!.headers.get('location')).toContain('http://localhost:4000/login')
  })
})

describe('hasPulseToken', () => {
  it('detects cookie and Bearer, false otherwise', () => {
    expect(hasPulseToken(makeReq('/x', { cookie: 't' }))).toBe(true)
    expect(hasPulseToken(makeReq('/x', { bearer: 't' }))).toBe(true)
    expect(hasPulseToken(makeReq('/x'))).toBe(false)
  })
})

describe('pulseLoginRedirect (standalone primitive for custom gates)', () => {
  it('builds a same-origin hub login redirect with a basePath-aware next', () => {
    const res = pulseLoginRedirect(makeReq('/properties/123', PROXY), { basePath: '/property' })
    expect(res.status).toBe(307)
    const u = new URL(res.headers.get('location')!)
    expect(u.origin).toBe('https://media002.tailc29663.ts.net')
    expect(u.pathname).toBe('/login')
    expect(u.searchParams.get('next')).toBe('https://media002.tailc29663.ts.net/property/properties/123')
  })
})
