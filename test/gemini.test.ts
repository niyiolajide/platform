import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Type } from '@google/genai'

const generateContent = vi.fn()
const constructorOptions: unknown[] = []
const warn = vi.fn()

class MockGoogleGenAI {
  readonly models = { generateContent }

  constructor(options: unknown) {
    constructorOptions.push(options)
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.doUnmock('@google/genai')
  vi.doUnmock('../src/config')
  generateContent.mockReset()
  warn.mockReset()
  constructorOptions.length = 0
  vi.doMock('@google/genai', () => ({ GoogleGenAI: MockGoogleGenAI, Type }))
  vi.doMock('../src/config', () => ({
    getLogger: () => ({ warn }),
    keys: { geminiApiKey: () => 'test-key' },
  }))
})

describe('geminiAdapter', () => {
  it('returns null and warns when the optional SDK is unavailable', async () => {
    vi.doUnmock('@google/genai')
    vi.doMock('@google/genai', () => {
      throw new Error('module not found')
    })
    const { geminiAdapter } = await import('../src/ai/gemini')

    const result = await geminiAdapter.callText(
      'gemini-2.5-flash',
      { prompt: 'hello' },
      new AbortController().signal,
    )

    expect(result).toEqual({ content: null })
    expect(warn).toHaveBeenCalledWith({}, '[ai/gemini] @google/genai not installed')
  })

  it('builds a schema-controlled flash request and maps response usage', async () => {
    generateContent.mockResolvedValue({
      text: '{"ok":true}',
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
    })
    const { geminiAdapter } = await import('../src/ai/gemini')
    const signal = new AbortController().signal

    const result = await geminiAdapter.callStructured(
      'gemini-2.5-flash',
      {
        prompt: 'Classify this',
        system: 'Return JSON',
        maxTokens: 900,
        toolName: 'classify',
        toolDescription: 'Classifies input',
        jsonSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
      signal,
    )

    expect(constructorOptions).toEqual([{ apiKey: 'test-key' }])
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: 'Classify this',
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 900,
        thinkingConfig: { thinkingBudget: 0 },
        systemInstruction: 'Return JSON',
        responseSchema: {
          type: Type.OBJECT,
          properties: { ok: { type: Type.BOOLEAN } },
          required: ['ok'],
        },
        abortSignal: signal,
        httpOptions: { timeout: 60_000 },
      },
    })
    expect(result).toEqual({
      content: { ok: true },
      usage: { tokensIn: 12, tokensOut: 4 },
    })
  })

  it('bounds thinking and widens the output budget for pro models', async () => {
    generateContent.mockResolvedValue({ text: '{"ok":true}' })
    const { geminiAdapter } = await import('../src/ai/gemini')

    await geminiAdapter.callStructured(
      'gemini-2.5-pro',
      {
        prompt: 'Classify this',
        maxTokens: 500,
        toolName: 'classify',
        toolDescription: 'Classifies input',
        jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
      new AbortController().signal,
    )

    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 1024 },
      }),
    }))
  })

  it('appends unsupported schemas to the prompt while keeping JSON mode', async () => {
    generateContent.mockResolvedValue({ text: '{"value":"yes"}' })
    const { geminiAdapter } = await import('../src/ai/gemini')
    const jsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] }

    await geminiAdapter.callStructured(
      'gemini-2.5-flash-lite',
      {
        prompt: 'Choose a value',
        toolName: 'choose',
        toolDescription: 'Chooses a value',
        jsonSchema,
      },
      new AbortController().signal,
    )

    const request = generateContent.mock.calls[0][0]
    expect(request.config.responseMimeType).toBe('application/json')
    expect(request.config.responseSchema).toBeUndefined()
    expect(request.contents).toBe(
      `Choose a value\n\nReturn ONLY a JSON object conforming to this JSON Schema (no markdown, no commentary):\n${JSON.stringify(jsonSchema)}`,
    )
  })

  it('trims text responses, nulls empty text, and reuses the client', async () => {
    generateContent
      .mockResolvedValueOnce({
        text: '  hello world  ',
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      })
      .mockResolvedValueOnce({ text: '   ' })
    const { geminiAdapter } = await import('../src/ai/gemini')
    const signal = new AbortController().signal

    const first = await geminiAdapter.callText(
      'gemini-2.5-flash',
      { prompt: 'hello', system: 'Be concise', maxTokens: 100 },
      signal,
    )
    const second = await geminiAdapter.callText(
      'gemini-2.5-flash-lite',
      { prompt: 'empty' },
      signal,
    )

    expect(first).toEqual({
      content: 'hello world',
      usage: { tokensIn: 3, tokensOut: 2 },
    })
    expect(second.content).toBeNull()
    expect(constructorOptions).toHaveLength(1)
    expect(generateContent.mock.calls[0][0]).toEqual({
      model: 'gemini-2.5-flash',
      contents: 'hello',
      config: {
        maxOutputTokens: 100,
        thinkingConfig: { thinkingBudget: 0 },
        systemInstruction: 'Be concise',
        abortSignal: signal,
        httpOptions: { timeout: 60_000 },
      },
    })
  })
})
