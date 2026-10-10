import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Guards the shippable surface the tarball-consumer gate (CI
// `verify-shipped-consumers.sh`) proves end to end: the exact subpath exports
// and the files glob must keep covering both versioned ESLint entries.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, unknown>
  files: string[]
}

describe('eslint packaging surface', () => {
  it('exposes separate ./eslint/v8 and ./eslint/v9 subpaths', () => {
    expect(pkg.exports['./eslint/v8']).toBe('./eslint-v8.mjs')
    expect(pkg.exports['./eslint/v9']).toBe('./eslint-v9.mjs')
  })

  it('ships every versioned entry through the files glob', () => {
    expect(pkg.files).toContain('eslint-*.mjs')
    for (const entry of ['eslint-v8.mjs', 'eslint-v9.mjs', 'eslint-config.mjs', 'eslint-rules.mjs']) {
      expect(existsSync(new URL(`../${entry}`, import.meta.url))).toBe(true)
    }
  })

  it('resolves both versioned defaults to non-empty flat-config arrays', async () => {
    const [{ default: v8 }, { default: v9 }] = await Promise.all([
      import('../eslint-v8.mjs'),
      import('../eslint-v9.mjs'),
    ])
    expect(Array.isArray(v8) && v8.length).toBeGreaterThan(0)
    expect(Array.isArray(v9) && v9.length).toBeGreaterThan(0)
    expect(v8.length).toBe(v9.length)
  })
})
