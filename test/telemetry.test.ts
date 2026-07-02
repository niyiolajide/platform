import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { _clearCache } from '../src/control'
import {
  setAiTelemetrySink,
  recordAiCall,
  ulid,
  createRedisSink,
  shipBuffer,
  AI_TELEMETRY_BUFFER_KEY,
  type AiCallRecord,
  type RedisLike,
} from '../src/ai/telemetry'
import { estimateCostCents, priceFor } from '../src/ai/models'

function baseRecord(over: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: ulid(),
    ts: new Date().toISOString(),
    app: 'testapp',
    userId: 'u1',
    purpose: 'unit',
    caller: 'direct',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    attempt: 1,
    status: 'ok',
    latencyMs: 12,
    ...over,
  }
}

// Person masking is driven by the hub-managed maskNames in control/ai.json
// (no hardcoded seed) — point the control store at a fixture with a fictional name.
let controlDir: string

beforeEach(() => {
  controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-control-'))
  fs.writeFileSync(path.join(controlDir, 'ai.json'), JSON.stringify({ maskNames: ['Jane Anne Doe'] }))
  process.env.CONTROL_DIR = controlDir
  _clearCache()
})
afterEach(() => {
  setAiTelemetrySink(null)
  fs.rmSync(controlDir, { recursive: true, force: true })
  delete process.env.CONTROL_DIR
  _clearCache()
})

describe('recordAiCall', () => {
  it('is a no-op when no sink is configured (never throws)', () => {
    setAiTelemetrySink(null)
    expect(() => recordAiCall(baseRecord())).not.toThrow()
  })

  it('passes a fully-built record to the sink', () => {
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    recordAiCall(baseRecord({ tokensIn: 100, tokensOut: 50, costCentsEst: 1.05 }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      app: 'testapp',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status: 'ok',
      tokensIn: 100,
      tokensOut: 50,
    })
  })

  it('anonymizes prompt + response in the client (idempotent)', () => {
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    recordAiCall(
      baseRecord({
        prompt: 'Email jane.doe@example.com about Jane Anne Doe',
        response: 'Will email jane.doe@example.com',
      }),
    )
    const r = seen[0]
    expect(r.prompt).not.toContain('jane.doe@example.com')
    expect(r.prompt).toContain('[EMAIL_1]')
    expect(r.prompt).toContain('[PERSON_1]')
    // Response anonymized with the same per-record mapping → same token for the email.
    expect(r.response).not.toContain('jane.doe@example.com')
    expect(r.response).toContain('[EMAIL_1]')
  })

  it('never throws even if the sink throws', () => {
    setAiTelemetrySink(() => {
      throw new Error('sink boom')
    })
    expect(() => recordAiCall(baseRecord())).not.toThrow()
  })
})

describe('ulid', () => {
  it('produces 26-char ids that sort by time', () => {
    const a = ulid(1_000)
    const b = ulid(2_000)
    expect(a).toHaveLength(26)
    expect(b).toHaveLength(26)
    expect(a < b).toBe(true)
  })

  it('is unique across rapid calls at the same ms', () => {
    const now = Date.now()
    const ids = new Set(Array.from({ length: 1000 }, () => ulid(now)))
    expect(ids.size).toBe(1000)
  })
})

describe('cost estimation', () => {
  it('prices a known model', () => {
    const cents = estimateCostCents('claude-sonnet-4-6', 1_000_000, 1_000_000)
    // 300 in + 1500 out cents/1M.
    expect(cents).toBeCloseTo(1800, 5)
  })

  it('resolves a dated model id to its base price via prefix match', () => {
    const p = priceFor('claude-haiku-4-5-20251001')
    expect(p?.model).toBe('claude-haiku-4-5')
  })

  it('omits cost for an unknown model', () => {
    expect(estimateCostCents('some-unknown-model', 100, 100)).toBeUndefined()
  })

  it('prices local Ollama at zero', () => {
    expect(estimateCostCents('qwen3:30b-a3b', 1000, 1000)).toBe(0)
  })

  it('omits cost when token counts are unavailable', () => {
    expect(estimateCostCents('claude-sonnet-4-6', undefined, undefined)).toBeUndefined()
  })
})

describe('redis helpers', () => {
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

  it('createRedisSink LPUSHes JSON onto the buffer', async () => {
    const redis = fakeRedis()
    const sink = createRedisSink(redis)
    sink(baseRecord({ id: 'X' }))
    await new Promise((r) => setTimeout(r, 0)) // sink is fire-and-forget
    expect(redis.list).toHaveLength(1)
    expect(JSON.parse(redis.list[0]).id).toBe('X')
  })

  it('shipBuffer drains oldest-first, posts a batch, and trims the shipped tail', async () => {
    const redis = fakeRedis()
    const sink = createRedisSink(redis)
    // Push 3 records: oldest is r1 (it ends up at the tail).
    for (const id of ['r1', 'r2', 'r3']) sink(baseRecord({ id }))
    await new Promise((r) => setTimeout(r, 0))
    expect(redis.list).toHaveLength(3)

    const posted: AiCallRecord[][] = []
    const n = await shipBuffer(redis, async (batch) => void posted.push(batch), 2)
    expect(n).toBe(2)
    // Oldest two shipped first, in oldest→newest order.
    expect(posted[0].map((r) => r.id)).toEqual(['r1', 'r2'])
    // Only the newest remains buffered.
    expect(redis.list).toHaveLength(1)
    expect(JSON.parse(redis.list[0]).id).toBe('r3')
  })

  it('shipBuffer leaves the buffer intact when the post fails (at-least-once)', async () => {
    const redis = fakeRedis()
    createRedisSink(redis)(baseRecord({ id: 'keep' }))
    await new Promise((r) => setTimeout(r, 0))
    await expect(
      shipBuffer(redis, async () => {
        throw new Error('hub down')
      }),
    ).rejects.toThrow('hub down')
    expect(redis.list).toHaveLength(1) // not trimmed
  })

  it('shipBuffer returns 0 on an empty buffer', async () => {
    const redis = fakeRedis()
    expect(await shipBuffer(redis, async () => {})).toBe(0)
  })

  it('uses the shared buffer key by default', () => {
    expect(AI_TELEMETRY_BUFFER_KEY).toBe('ai:telemetry:buffer')
  })
})
