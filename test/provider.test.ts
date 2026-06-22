import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveAiProvider, anyAiConfigured, getProvider } from '../src/ai/provider'
import { publishAiSettings, _clearCache, AI_SETTINGS_SCHEMA } from '../src/control'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'))
  process.env.CONTROL_DIR = dir
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GEMINI_API_KEY
  _clearCache()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveAiProvider', () => {
  it('returns null when no provider is configured', () => {
    expect(anyAiConfigured()).toBe(false)
    expect(resolveAiProvider()).toBeNull()
  })

  it('honors an explicit preference when configured', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    process.env.GEMINI_API_KEY = 'g'
    _clearCache()
    expect(resolveAiProvider('gemini')?.kind).toBe('gemini')
    expect(resolveAiProvider('anthropic')?.kind).toBe('anthropic')
  })

  it('falls back to the other configured provider when the preferred lacks a key', () => {
    process.env.ANTHROPIC_API_KEY = 'k' // only anthropic configured
    _clearCache()
    // Prefer gemini, but it has no key → fall back to anthropic.
    expect(resolveAiProvider('gemini')?.kind).toBe('anthropic')
  })

  it('does not fall back when fallbackEnabled is false', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({ provider: 'gemini', fallbackEnabled: false }))
    _clearCache()
    // Provider is gemini (from file), no key, fallback disabled → null.
    expect(resolveAiProvider()).toBeNull()
  })

  it('uses the control-bus provider when no explicit preference is given', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    process.env.GEMINI_API_KEY = 'g'
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({ provider: 'gemini' }))
    _clearCache()
    expect(resolveAiProvider()?.kind).toBe('gemini')
  })

  it('reflects model names from the control-bus cascade', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    publishAiSettings(
      AI_SETTINGS_SCHEMA.parse({
        cascades: {
          main: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
          fast: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
        },
      }),
    )
    _clearCache()
    expect(getProvider('anthropic').modelName('main')).toBe('claude-opus-4-8')
  })
})
