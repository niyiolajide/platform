import { describe, it, expect } from 'vitest'
import {
  ulid,
  createUsageSink,
  shipUsageEvents,
  sessionize,
  USAGE_BUFFER_KEY,
  SESSION_GAP_MS,
  type UsageEvent,
  type RedisLike,
} from '../src/analytics'

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: ulid(),
    ts: new Date().toISOString(),
    app: 'finpulse',
    surface: 'web',
    screenKey: 'dashboard',
    type: 'view',
    ...over,
  }
}

function fakeRedis(): RedisLike & { list: string[] } {
  const list: string[] = []
  return {
    list,
    async lpush(_key, ...values) {
      list.unshift(...values)
      return list.length
    },
    async lrange(_key, start, stop) {
      const n = list.length
      const s = start < 0 ? Math.max(n + start, 0) : start
      const e = stop < 0 ? n + stop : stop
      return list.slice(s, e + 1)
    },
    async ltrim(_key, start, stop) {
      const n = list.length
      const s = start < 0 ? Math.max(n + start, 0) : start
      const e = stop < 0 ? n + stop : stop
      const kept = list.slice(s, e + 1)
      list.length = 0
      list.push(...kept)
      return 'OK'
    },
  }
}

describe('usage buffer', () => {
  it('createUsageSink LPUSHes JSON onto the shared key', async () => {
    const redis = fakeRedis()
    createUsageSink(redis)(ev({ id: 'U' }))
    await new Promise((r) => setTimeout(r, 0)) // fire-and-forget
    expect(redis.list).toHaveLength(1)
    expect(JSON.parse(redis.list[0]).id).toBe('U')
    expect(USAGE_BUFFER_KEY).toBe('usage:buffer')
  })

  it('shipUsageEvents drains oldest-first and trims the shipped tail', async () => {
    const redis = fakeRedis()
    const sink = createUsageSink(redis)
    for (const id of ['e1', 'e2', 'e3']) sink(ev({ id }))
    await new Promise((r) => setTimeout(r, 0))

    const posted: UsageEvent[][] = []
    const n = await shipUsageEvents(redis, async (b) => void posted.push(b), 2)
    expect(n).toBe(2)
    expect(posted[0].map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(redis.list).toHaveLength(1)
    expect(JSON.parse(redis.list[0]).id).toBe('e3')
  })

  it('shipUsageEvents leaves the buffer intact when the post fails', async () => {
    const redis = fakeRedis()
    createUsageSink(redis)(ev({ id: 'keep' }))
    await new Promise((r) => setTimeout(r, 0))
    await expect(
      shipUsageEvents(redis, async () => {
        throw new Error('db down')
      }),
    ).rejects.toThrow('db down')
    expect(redis.list).toHaveLength(1)
  })
})

describe('sessionize', () => {
  const base = Date.parse('2026-06-25T10:00:00.000Z')
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString()

  it('groups events within the gap into one stable session and splits on a >30m gap', () => {
    const events: UsageEvent[] = [
      ev({ id: 'a', ts: at(0) }),
      ev({ id: 'b', ts: at(5 * 60_000) }), // +5m → same session
      ev({ id: 'c', ts: at(5 * 60_000 + SESSION_GAP_MS + 1) }), // +>30m → new session
    ]
    const out = sessionize(events)
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']) // sorted by ts
    expect(out[0].sessionId).toBe(out[1].sessionId)
    expect(out[2].sessionId).not.toBe(out[0].sessionId)
    // Stable: re-running yields the same ids (keyed off the first event of each session).
    expect(sessionize(events).map((e) => e.sessionId)).toEqual(out.map((e) => e.sessionId))
  })

  it('sorts unordered input before splitting', () => {
    const out = sessionize([ev({ id: 'late', ts: at(60_000) }), ev({ id: 'early', ts: at(0) })])
    expect(out.map((e) => e.id)).toEqual(['early', 'late'])
    expect(out[0].sessionId).toBe(out[1].sessionId)
  })
})
