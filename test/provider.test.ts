import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── Mock the adapter registry so the cascade can be driven deterministically ───
// Each adapter's configured()/outcome is controlled via `ctl`; every call is
// recorded in `calls` (with the prompt actually sent, to assert masking policy).
type Outcome = { mode: 'value' | 'null' | 'throw'; value?: unknown }
const ctl: Record<string, { configured: boolean; structured: Outcome; text: Outcome }> = {
  gemini: { configured: true, structured: { mode: 'value', value: { ok: 'g' } }, text: { mode: 'value', value: 'g' } },
  anthropic: { configured: true, structured: { mode: 'value', value: { ok: 'a' } }, text: { mode: 'value', value: 'a' } },
  ollama: { configured: true, structured: { mode: 'value', value: { ok: 'o' } }, text: { mode: 'value', value: 'o' } },
}
const calls: Array<{ kind: string; model: string; type: string; prompt: string }> = []

function run(kind: string, model: string, type: 'structured' | 'text', prompt: string) {
  calls.push({ kind, model, type, prompt })
  const o = ctl[kind][type]
  if (o.mode === 'throw') throw new Error(`${kind} boom`)
  if (o.mode === 'null') return { content: null }
  return { content: o.value, usage: { tokensIn: 10, tokensOut: 5 } }
}

vi.mock('../src/ai/registry', () => {
  const make = (kind: string, label: string, local = false) => ({
    kind,
    label,
    local,
    configured: () => ctl[kind].configured,
    callStructured: async (model: string, req: { prompt: string }) => run(kind, model, 'structured', req.prompt),
    callText: async (model: string, req: { prompt: string }) => run(kind, model, 'text', req.prompt),
  })
  const ADAPTERS = {
    gemini: make('gemini', 'Gemini (Google)'),
    anthropic: make('anthropic', 'Claude (Anthropic)'),
    ollama: make('ollama', 'Ollama (local)', true),
  }
  return { ADAPTERS, getAdapter: (k: keyof typeof ADAPTERS) => ADAPTERS[k] }
})

import { resolveAiProvider, getProvider, anyAiConfigured } from '../src/ai/provider'
import { setAiTelemetrySink, type AiCallRecord } from '../src/ai/telemetry'
import { publishAiSettings, _clearCache, AI_SETTINGS_SCHEMA } from '../src/control'

const SREQ = { prompt: 'hello', toolName: 't', toolDescription: 'd', jsonSchema: { type: 'object' } }

function reset() {
  for (const k of Object.keys(ctl)) {
    ctl[k].configured = true
    ctl[k].structured = { mode: 'value', value: { ok: k[0] } }
    ctl[k].text = { mode: 'value', value: k[0] }
  }
  calls.length = 0
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'))
  process.env.CONTROL_DIR = dir
  _clearCache()
  reset()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// Anonymization off by default in tests unless a case enables it.
function noAnon() {
  publishAiSettings(AI_SETTINGS_SCHEMA.parse({ anonymizeRequests: false }))
  _clearCache()
}

describe('cascade executor', () => {
  it('returns null only when no step is configured', () => {
    noAnon()
    for (const k of Object.keys(ctl)) ctl[k].configured = false
    expect(anyAiConfigured()).toBe(false)
    expect(resolveAiProvider()).toBeNull()
  })

  it('answers from the first configured step (Gemini leads by default)', async () => {
    noAnon()
    const out = await resolveAiProvider()!.generateText({ prompt: 'hi' })
    expect(out).toBe('g')
    expect(calls[0]).toMatchObject({ kind: 'gemini', model: 'gemini-2.5-pro' })
  })

  it('falls through to the next provider on a thrown error', async () => {
    noAnon()
    ctl.gemini.text = { mode: 'throw' } // both gemini steps throw
    const out = await resolveAiProvider()!.generateText({ prompt: 'hi' })
    expect(out).toBe('a') // anthropic answered
    expect(calls.map((c) => c.kind)).toEqual(['gemini', 'gemini', 'anthropic'])
  })

  it('falls through on an empty/null response', async () => {
    noAnon()
    ctl.gemini.structured = { mode: 'null' }
    const out = await resolveAiProvider()!.generateStructured(SREQ)
    expect(out).toEqual({ ok: 'a' })
  })

  it('returns null when every step fails', async () => {
    noAnon()
    for (const k of Object.keys(ctl)) ctl[k].text = { mode: 'throw' }
    const out = await resolveAiProvider()!.generateText({ prompt: 'hi' })
    expect(out).toBeNull()
    expect(calls.length).toBe(4) // gemini x2, anthropic, ollama
  })

  it('hoists an explicit provider preference to the front', async () => {
    noAnon()
    const out = await resolveAiProvider('anthropic')!.generateText({ prompt: 'hi' })
    expect(out).toBe('a')
    expect(calls[0].kind).toBe('anthropic')
  })

  it('modelName reports the model that actually answered', async () => {
    noAnon()
    ctl.gemini.text = { mode: 'throw' }
    const p = resolveAiProvider()!
    await p.generateText({ prompt: 'hi' })
    expect(p.modelName('main')).toBe('claude-sonnet-4-6')
  })

  it('getProvider restricts the cascade to one provider', async () => {
    noAnon()
    const out = await getProvider('ollama').generateText({ prompt: 'hi' })
    expect(out).toBe('o')
    expect(calls.every((c) => c.kind === 'ollama')).toBe(true)
  })
})

describe('anonymization policy in the cascade', () => {
  it('masks for cloud steps but sends the original to local Ollama', async () => {
    // anonymize ON (schema default). Force gemini+anthropic to fail so Ollama answers.
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({}))
    _clearCache()
    ctl.gemini.text = { mode: 'throw' }
    ctl.anthropic.text = { mode: 'throw' }
    const prompt = 'Email me at jane@example.com about it'
    const out = await resolveAiProvider()!.generateText({ prompt })
    expect(out).toBe('o')
    const gemini = calls.find((c) => c.kind === 'gemini')!
    const ollama = calls.find((c) => c.kind === 'ollama')!
    expect(gemini.prompt).toContain('[EMAIL_1]') // cloud saw a masked prompt
    expect(gemini.prompt).not.toContain('jane@example.com')
    expect(ollama.prompt).toBe(prompt) // local saw the original, unmasked
  })
})

describe('cascade telemetry', () => {
  afterEach(() => setAiTelemetrySink(null))

  it('emits no records when no sink is installed', async () => {
    noAnon()
    setAiTelemetrySink(null)
    // (No throw, no observable effect — just confirm the call still works.)
    const out = await resolveAiProvider()!.generateText({ prompt: 'hi' })
    expect(out).toBe('g')
  })

  it('emits an ok record for the answering step with tier/provider/model/usage/cost', async () => {
    noAnon()
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    await resolveAiProvider()!.generateText({ prompt: 'hi', app: 'finpulse', purpose: 'digest', userId: 'u9' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      app: 'finpulse',
      purpose: 'digest',
      userId: 'u9',
      caller: 'cascade',
      tier: 'main',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      attempt: 1,
      status: 'ok',
      tokensIn: 10,
      tokensOut: 5,
    })
    // gemini-2.5-pro priced → cost present.
    expect(typeof seen[0].costCentsEst).toBe('number')
    expect(seen[0].id).toHaveLength(26)
    expect(seen[0].prompt).toBe('hi')
    expect(seen[0].response).toBe('g')
  })

  it('emits one record per attempt incl. error + the final ok', async () => {
    noAnon()
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    ctl.gemini.text = { mode: 'throw' } // both gemini steps throw → anthropic answers
    const out = await resolveAiProvider()!.generateText({ prompt: 'hi' })
    expect(out).toBe('a')
    expect(seen.map((r) => `${r.provider}:${r.status}`)).toEqual([
      'gemini:error',
      'gemini:error',
      'anthropic:ok',
    ])
    expect(seen[0].error).toContain('boom')
    expect(seen[2].attempt).toBe(3)
  })

  it('omits prompt/response when logPayloads is false', async () => {
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({ anonymizeRequests: false, logPayloads: false }))
    _clearCache()
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    await resolveAiProvider()!.generateText({ prompt: 'secret prompt' })
    expect(seen).toHaveLength(1)
    expect(seen[0].prompt).toBeUndefined()
    expect(seen[0].response).toBeUndefined()
    // Metadata still recorded.
    expect(seen[0].status).toBe('ok')
  })

  it('emits nothing when logAiCalls is false', async () => {
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({ anonymizeRequests: false, logAiCalls: false }))
    _clearCache()
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    await resolveAiProvider()!.generateText({ prompt: 'hi' })
    expect(seen).toHaveLength(0)
  })

  it('records the ANONYMIZED prompt+response when anonymize is on', async () => {
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({})) // anonymize on (default)
    _clearCache()
    const seen: AiCallRecord[] = []
    setAiTelemetrySink((r) => seen.push(r))
    ctl.gemini.text = { mode: 'value', value: 'see jane@example.com' }
    await resolveAiProvider()!.generateText({ prompt: 'Email jane@example.com now' })
    const rec = seen.find((r) => r.status === 'ok')!
    expect(rec.prompt).not.toContain('jane@example.com')
    expect(rec.prompt).toContain('[EMAIL_1]')
    expect(rec.response).not.toContain('jane@example.com')
  })
})
