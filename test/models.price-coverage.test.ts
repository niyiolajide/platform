import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { AI_MODELS, priceFor } from '../src/ai/models'
import { AI_SETTINGS_SCHEMA, DEFAULT_CASCADES } from '../src/control/schema'

type Provider = keyof typeof AI_MODELS

const PRICE_LOOKUP_DATE = new Date('9999-12-31T00:00:00.000Z')
const LEGACY_MODEL_KEYS = [
  'anthropicModel',
  'anthropicModelFast',
  'geminiModel',
  'geminiModelFast',
  'geminiModelFallback',
] as const

function expectPrice(model: string) {
  expect(priceFor(model, PRICE_LOOKUP_DATE), `${model} is missing a price row`).not.toBeNull()
}

function expectAllowed(provider: Provider, model: string) {
  expect(
    (AI_MODELS[provider] as readonly string[]).includes(model),
    `${provider}/${model} is missing from AI_MODELS`,
  ).toBe(true)
}

describe('model price coverage', () => {
  it('prices every default cascade and legacy scalar model', () => {
    for (const cascade of Object.values(DEFAULT_CASCADES)) {
      for (const step of cascade) {
        expectPrice(step.model)
      }
    }

    const defaults = AI_SETTINGS_SCHEMA.parse({})
    for (const key of LEGACY_MODEL_KEYS) {
      expectPrice(defaults[key])
    }
  })

  it('prices every model offered by AI_MODELS', () => {
    for (const models of Object.values(AI_MODELS)) {
      for (const model of models) {
        expectPrice(model)
      }
    }
  })
})

const hostAiCandidates = [
  path.join(process.env.CONTROL_DIR ?? '/control', 'ai.json'),
  '/Users/niyi/scripts/shared/control/ai.json',
]
const hostAiPath = hostAiCandidates.find(existsSync)
const describeHostAi = hostAiPath ? describe : describe.skip
const hostSuiteName = hostAiPath
  ? `host AI configuration (${hostAiPath})`
  : `host AI configuration (skipped: neither ${hostAiCandidates.join(' nor ')} exists)`

describeHostAi(hostSuiteName, () => {
  it('uses only allowed, priced models', () => {
    if (!hostAiPath) {throw new Error('host AI configuration path was not resolved')}
    const config = JSON.parse(readFileSync(hostAiPath, 'utf8')) as Record<string, unknown>
    const cascades = config.cascades

    expect(cascades, 'cascades must be an object').toBeTypeOf('object')
    expect(cascades).not.toBeNull()

    for (const [tier, rawSteps] of Object.entries(cascades as Record<string, unknown>)) {
      expect(Array.isArray(rawSteps), `cascades.${tier} must be an array`).toBe(true)
      for (const [index, rawStep] of (rawSteps as unknown[]).entries()) {
        expect(rawStep, `cascades.${tier}[${index}] must be an object`).toBeTypeOf('object')
        expect(rawStep).not.toBeNull()
        const step = rawStep as Record<string, unknown>
        expect(['anthropic', 'gemini', 'ollama']).toContain(step.provider)
        expect(step.model, `cascades.${tier}[${index}].model must be a string`).toBeTypeOf('string')

        const provider = step.provider as Provider
        const model = step.model as string
        expectAllowed(provider, model)
        const price = priceFor(model, PRICE_LOOKUP_DATE)
        expect(price, `${provider}/${model} is missing a price row`).not.toBeNull()
        if (provider === 'ollama') {
          expect(price).toMatchObject({ per1MInCents: 0, per1MOutCents: 0 })
        }
      }
    }

    for (const [key, value] of Object.entries(config)) {
      const match = /^(anthropic|gemini).*model/i.exec(key)
      if (!match) {continue}
      expect(value, `${key} must be a string`).toBeTypeOf('string')
      const provider = match[1].toLowerCase() as Provider
      const model = value as string
      expectAllowed(provider, model)
      expectPrice(model)
    }
  })
})
