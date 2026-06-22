import { describe, it, expect } from 'vitest'
import { parseJsonObject, stripThink, toGeminiSchema } from '../src/ai/util'

describe('parseJsonObject', () => {
  it('extracts a JSON object from surrounding prose', () => {
    expect(parseJsonObject('here you go: {"a":1} done')).toEqual({ a: 1 })
  })
  it('returns null on unparseable text', () => {
    expect(parseJsonObject('no json here')).toBeNull()
    expect(parseJsonObject('')).toBeNull()
  })
})

describe('stripThink', () => {
  it('removes <think> reasoning blocks (qwen3)', () => {
    expect(stripThink('<think>hmm the user wants</think>pong')).toBe('pong')
  })
  it('leaves normal text untouched', () => {
    expect(stripThink('just text')).toBe('just text')
  })
})

describe('toGeminiSchema', () => {
  it('converts the common object/enum/array subset', () => {
    const out = toGeminiSchema({
      type: 'object',
      properties: {
        sentiment: { type: 'string', enum: ['positive', 'negative'] },
        score: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['sentiment'],
    })
    expect(out).toEqual({
      type: 'object',
      properties: {
        sentiment: { type: 'string', format: 'enum', enum: ['positive', 'negative'] },
        score: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['sentiment'],
    })
  })
  it('bails to null on unsupported constructs (so the caller falls back)', () => {
    expect(toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBeNull()
    expect(toGeminiSchema({ type: 'object', properties: { x: { type: 'weird' } } })).toBeNull()
  })
})
