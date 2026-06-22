import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readAiSettings,
  publishAiSettings,
  aiConfigSource,
  isRevoked,
  revokeJti,
  publishRevocations,
  readRevocations,
  _clearCache,
  AI_SETTINGS_SCHEMA,
} from '../src/control'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'))
  process.env.CONTROL_DIR = dir
  delete process.env.ANTHROPIC_MODEL
  _clearCache()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ai settings', () => {
  it('uses schema defaults when no file is present (env-default)', () => {
    expect(aiConfigSource()).toBe('env-default')
    const s = readAiSettings()
    // Legacy scalars are now derived from the default cascade (the source of truth):
    // main's first anthropic step, fast's first anthropic step.
    expect(s.anthropicModel).toBe('claude-sonnet-4-6')
    expect(s.anthropicModelFast).toBe('claude-haiku-4-5')
    expect(s.cascades.main[0]).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' })
  })

  it('env defaults override schema defaults', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'
    _clearCache()
    expect(readAiSettings().anthropicModel).toBe('claude-opus-4-8')
  })

  it('published cascade is the source of truth; legacy scalars derive from it', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'
    publishAiSettings(
      AI_SETTINGS_SCHEMA.parse({
        cascades: {
          main: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
          fast: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
        },
      }),
    )
    _clearCache()
    expect(aiConfigSource()).toBe('file')
    const s = readAiSettings()
    // The published cascade wins over the ANTHROPIC_MODEL env default; the legacy
    // scalar is backfilled from the cascade's first anthropic step.
    expect(s.cascades.main[0].model).toBe('claude-haiku-4-5')
    expect(s.anthropicModel).toBe('claude-haiku-4-5')
  })

  it('synthesizes a cascade from a legacy ai.json that predates cascades', () => {
    // A file written by the OLD hub: legacy fields, no `cascades` key.
    fs.writeFileSync(
      path.join(dir, 'ai.json'),
      JSON.stringify({ schemaVersion: 1, provider: 'gemini', geminiModel: 'gemini-2.5-flash' }),
    )
    _clearCache()
    const s = readAiSettings()
    // Gemini-first (from legacy `provider`), with Claude + Ollama appended as fallback.
    expect(s.cascades.main[0].provider).toBe('gemini')
    expect(s.cascades.main.some((x) => x.provider === 'anthropic')).toBe(true)
    expect(s.cascades.main.some((x) => x.provider === 'ollama')).toBe(true)
  })

  it('tolerant read of an older schemaVersion with missing fields', () => {
    // Simulate a file written by an older hub: only a couple of fields.
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ schemaVersion: 0, provider: 'anthropic' }))
    _clearCache()
    const s = readAiSettings()
    // Missing fields fall back to schema defaults rather than throwing.
    expect(s.anthropicModel).toBe('claude-sonnet-4-6')
    expect(s.geminiModelFallback).toBe('gemini-2.5-flash-lite')
  })
})

describe('revocations', () => {
  it('reports revoked jtis and prunes expired entries on publish', () => {
    expect(isRevoked('abc')).toBe(false)
    const future = Math.floor(Date.now() / 1000) + 3600
    const past = Math.floor(Date.now() / 1000) - 10
    revokeJti('abc', future)
    _clearCache()
    expect(isRevoked('abc')).toBe(true)
    // Publishing prunes already-expired entries.
    publishRevocations({ schemaVersion: 1, revoked: [{ jti: 'abc', exp: future }, { jti: 'old', exp: past }] })
    _clearCache()
    expect(readRevocations().revoked.map((r) => r.jti)).toEqual(['abc'])
  })
})
