import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { hubAuthGate, type HubAuthGateOptions } from '../src/edge'

function makeReq(
  path: string,
  o: { method?: string; cookie?: string; bearer?: string; host?: string; proto?: string } = {},
) {
  const headers = new Headers()
  if (o.cookie) headers.set('cookie', `hub-token=${o.cookie}`)
  if (o.bearer) headers.set('authorization', `Bearer ${o.bearer}`)
  if (o.host) headers.set('x-forwarded-host', o.host)
  if (o.proto) headers.set('x-forwarded-proto', o.proto)
  return new NextRequest(`https://backend.internal${path}`, { method: o.method ?? 'GET', headers })
}

const PROXY = { host: 'media002.tailc29663.ts.net', proto: 'https' }
const opts: HubAuthGateOptions = {
  basePath: '/vantage',
  publicPrefixes: ['/api/health', '/_next', '/favicon'],
  publicGetPrefixes: ['/wisdom/'],
}

describe('hubAuthGate', () => {
  it('bypasses public prefixes (all methods)', () => {
    expect(hubAuthGate(makeReq('/api/health', PROXY), opts)).toBeNull()
    expect(hubAuthGate(makeReq('/_next/static/x.js', PROXY), opts)).toBeNull()
  })

  it('bypasses public GET prefixes only for GET/HEAD', () => {
    expect(hubAuthGate(makeReq('/wisdom/seneca-1', { ...PROXY, method: 'GET' }), opts)).toBeNull()
    // a mutation to the same prefix must NOT bypass
    expect(hubAuthGate(makeReq('/wisdom/seneca-1', { ...PROXY, method: 'POST' }), opts)).not.toBeNull()
  })

  it('passes when a hub-token cookie is present', () => {
    expect(hubAuthGate(makeReq('/dashboard', { ...PROXY, cookie: 'abc.def.ghi' }), opts)).toBeNull()
  })

  it('passes when a Bearer token is present', () => {
    expect(hubAuthGate(makeReq('/dashboard', { ...PROXY, bearer: 'abc.def.ghi' }), opts)).toBeNull()
  })

  it('returns 401 JSON for unauthenticated /api/*', () => {
    const res = hubAuthGate(makeReq('/api/transactions', PROXY), opts)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('redirects unauthenticated pages to the same-origin hub login with a basePath-aware next', () => {
    const res = hubAuthGate(makeReq('/dashboard', PROXY), opts)
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
    const res = hubAuthGate(makeReq('/dashboard'), { ...opts, hubUrlFallback: 'http://localhost:4000' })
    expect(res!.status).toBe(307)
    expect(res!.headers.get('location')).toContain('http://localhost:4000/login')
  })
})
