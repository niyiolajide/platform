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
    expect(s.provider).toBe('anthropic')
    expect(s.anthropicModel).toBe('claude-sonnet-4-6')
    expect(s.anthropicModelFast).toBe('claude-haiku-4-5-20251001')
  })

  it('env defaults override schema defaults', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'
    _clearCache()
    expect(readAiSettings().anthropicModel).toBe('claude-opus-4-8')
  })

  it('published file overrides env defaults (round-trip)', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'
    publishAiSettings(AI_SETTINGS_SCHEMA.parse({ provider: 'gemini', anthropicModel: 'claude-haiku-4-5' }))
    _clearCache()
    expect(aiConfigSource()).toBe('file')
    const s = readAiSettings()
    expect(s.provider).toBe('gemini')
    expect(s.anthropicModel).toBe('claude-haiku-4-5')
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
