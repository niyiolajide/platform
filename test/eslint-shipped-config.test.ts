import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Linter as Linter8 } from 'eslint'
import { Linter as Linter9 } from 'eslint9'
import { describe, expect, it } from 'vitest'
import { node, nodeV9 } from '../eslint-config.mjs'
import v8Entry from '../eslint-v8.mjs'
import v9Entry from '../eslint-v9.mjs'

// These matrices execute the ACTUAL shipped flat configs through the real
// ESLint 8 and ESLint 9 engines: v8Entry/v9Entry are the exact arrays the
// ./eslint/v8 and ./eslint/v9 package exports resolve to, and node()/nodeV9()
// are the shipped node variants. Inline snippets use synthetic code only.
//
// Two deliberate test-side adaptations (shipped files are untouched):
// - Scheduler cases use absolute filenames under src/worker. The pulse
//   scheduler rule intentionally keys off absolute-style server paths, and
//   Linter.verify keeps relative filenames relative, so only absolute paths
//   exercise the real server-file/heartbeat logic.
// - Typed cases pin parser discovery to the explicit tsconfig.eslint.json
//   program. The shipped projectService options bind .ts files to the nearest
//   tsconfig.json, which covers src/ only in this repo (platform lint input
//   is src-only, so production use is unaffected); test fixtures live under
//   test/ and would otherwise miss the program. Rules, severities, plugins
//   and the type program itself are unchanged.
function withExplicitProject(config: readonly unknown[]) {
  return config.map((block) => {
    const candidate = block as {
      languageOptions?: { parserOptions?: Record<string, unknown> }
    }
    if (candidate?.languageOptions?.parserOptions?.projectService) {
      const { projectService: _dropped, ...rest } = candidate.languageOptions.parserOptions
      return {
        ...(block as Record<string, unknown>),
        languageOptions: {
          ...candidate.languageOptions,
          parserOptions: { ...rest, project: ['./tsconfig.eslint.json'], tsconfigRootDir: process.cwd() },
        },
      }
    }
    return block
  })
}

const root = process.cwd()
const abs = (rel: string) => join(root, rel)
const fixture = (name: string) => readFileSync(abs(`test/fixtures/eslint-compat/${name}`), 'utf8')

const linter8 = new Linter8({ configType: 'flat' })
const linter9 = new Linter9()

const engines = [
  { label: 'eslint8', linter: linter8, config: v8Entry as never, nodeConfig: node() as never },
  { label: 'eslint9', linter: linter9, config: v9Entry as never, nodeConfig: nodeV9() as never },
] as const

function ruleIds(messages: { ruleId: string | null; fatal?: boolean }[]) {
  const fatal = messages.filter((m) => m.fatal)
  if (fatal.length > 0) {
    throw new Error(`fatal parse errors: ${JSON.stringify(fatal)}`)
  }
  return messages.map((m) => m.ruleId).filter((id): id is string => id !== null)
}

const securityBad = "const code = '2 + 2';\nconst out = eval(code);\nexport { out };\n"
const securityGood = 'export const out = 2 + 2;\n'
const schedulerBad = "import cron from 'node-cron';\ncron.schedule('* * * * *', () => {});\n"
const schedulerGood = 'function updateHeartbeat() {}\nsetInterval(updateHeartbeat, 1000);\n'
const designBad =
  'export function Badge() {\n  return <span style={{ color: \'red\' }} className="bg-white">ok</span>;\n}\n'
const designGood = 'export function Badge() {\n  return <span className="bg-surface">ok</span>;\n}\n'
const nextBad = 'export function Hero() {\n  return <img src="/hero.png" alt="hero" />;\n}\n'
const secretBad =
  "'use client';\nimport fs from 'node:fs';\nconst token = process.env.SECRET_TOKEN;\nexport function load() {\n  return [fs, token];\n}\n"
const secretGood =
  "'use client';\nconst appId = process.env.NEXT_PUBLIC_APP_ID;\nexport function show() {\n  return appId;\n}\n"

describe.each(engines)('shipped config on $label', (engine) => {
  it('rejects eval payloads via core and security rules, passes clean code', () => {
    const bad = ruleIds(engine.linter.verify(securityBad, engine.config, 'src/lib/evaluate.js'))
    expect(bad).toContain('no-eval')
    expect(bad).toContain('security/detect-eval-with-expression')
    expect(ruleIds(engine.linter.verify(securityGood, engine.config, 'src/lib/evaluate.js'))).toEqual([])
  })

  it('rejects app-local schedulers, allows heartbeat intervals', () => {
    const bad = ruleIds(
      engine.linter.verify(schedulerBad, engine.nodeConfig, abs('src/worker/scheduler.js')),
    )
    expect(bad).toContain('pulse/no-app-local-scheduler')
    expect(
      ruleIds(engine.linter.verify(schedulerGood, engine.nodeConfig, abs('src/worker/index.js'))),
    ).toEqual([])
  })

  it('rejects inline styles and raw colors, passes semantic tokens', () => {
    const bad = ruleIds(engine.linter.verify(designBad, engine.config, 'src/components/Badge.jsx'))
    expect(bad.filter((id) => id === 'no-restricted-syntax').length).toBe(2)
    expect(ruleIds(engine.linter.verify(designGood, engine.config, 'src/components/Badge.jsx'))).toEqual([])
  })

  it('rejects raw img elements via the Next plugin', () => {
    const bad = ruleIds(engine.linter.verify(nextBad, engine.config, 'src/components/Hero.jsx'))
    expect(bad).toContain('@next/next/no-img-element')
  })

  it('rejects server secrets in client components, passes public env', () => {
    const bad = ruleIds(engine.linter.verify(secretBad, engine.config, 'src/components/Loader.jsx'))
    expect(bad).toContain('pulse/no-client-server-secret-access')
    expect(ruleIds(engine.linter.verify(secretGood, engine.config, 'src/components/Loader.jsx'))).toEqual([])
  })

  it('flags mistyped async code and passes clean typed code', () => {
    const typed = withExplicitProject(engine.config as readonly unknown[])
    const bad = ruleIds(
      engine.linter.verify(fixture('bad-typed.ts'), typed as never, abs('test/fixtures/eslint-compat/bad-typed.ts')),
    )
    expect(bad).toContain('@typescript-eslint/no-floating-promises')
    expect(bad).toContain('@typescript-eslint/await-thenable')
    const good = ruleIds(
      engine.linter.verify(fixture('good-typed.ts'), typed as never, abs('test/fixtures/eslint-compat/good-typed.ts')),
    )
    expect(good).toEqual([])
  })
})
