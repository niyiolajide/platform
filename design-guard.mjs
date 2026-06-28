#!/usr/bin/env node
/**
 * Pulse design-system + platform guard — fails (exit 1) on drift from @niyi/ui or
 * on basePath-unsafe navigation. Zero deps. Identical across all platform apps.
 * Enforces the rules that have unambiguous, token-based alternatives:
 *   1. raw palette classes (slate/gray/zinc/neutral ladder) → use ink/muted/line/surface/canvas/primary/success/warning/error
 *   2. arbitrary font-size px (text-[13px]) → use text-xs/sm/base/lg/...
 *   3. off-brand font @import / font-family in CSS → only Plus Jakarta Sans / DM Serif Display / JetBrains Mono
 *   4. local forks of @niyi/ui primitives in components/ui/ → import from @niyi/ui (single source of truth)
 *   5. basePath-unsafe nav: raw <a>/<form> or location.href to an app-absolute path that drops the
 *      next.config.js basePath and 404s → use next/link <Link> / router.push (auto-prefixed), or
 *      prefix with the basePath for full-navigation API routes.
 * Data-driven colors, Recharts colors, and dimensional px are intentionally NOT flagged (sanctioned exceptions).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'

const ROOT = process.argv[2] || 'src'
const FORK_NAMES = new Set(['Button', 'Card', 'Input', 'Badge', 'StatCard', 'Modal', 'EmptyState', 'LoadingSpinner', 'PageHeader', 'Pagination', 'SegmentedControl', 'PageState'])
const OFF_FONTS = /\b(Fraunces|Newsreader|IBM Plex|Roboto|Poppins|Lato|Montserrat|Open Sans|Nunito|Source Sans)\b/
const PALETTE = /\b(?:text|bg|border|ring|divide|from|to|via|fill|stroke|placeholder|decoration|outline)(?:-[lrtbxyse])?-(?:slate|gray|zinc|neutral)-\d{1,3}\b/
const FONT_PX = /text-\[[0-9.]+px\]/

// basePath this app is mounted under (e.g. '/lifepulse'), read from next.config.js.
// Empty for root-served apps (the nav rule then no-ops — absolute paths are correct).
function detectBasePath() {
  for (const f of ['next.config.js', 'next.config.mjs']) {
    if (existsSync(f)) {
      const m = readFileSync(f, 'utf8').match(/basePath:\s*['"]([^'"]+)['"]/)
      if (m) return m[1]
    }
  }
  return ''
}
const BASE_PATH = detectBasePath()

// An app-absolute string path ("/x") that is NOT already basePath-prefixed and NOT external (//, http).
function isUnsafePath(p) {
  if (!BASE_PATH) return false
  if (!p.startsWith('/') || p.startsWith('//')) return false
  if (p === BASE_PATH || p.startsWith(BASE_PATH + '/')) return false
  return true
}

const NAV_TAG_OPEN = /<([A-Za-z][A-Za-z0-9]*)/g
const HREF_ACTION = /\b(?:href|action)=["'](\/[^"']*)["']/
const LOC_ASSIGN = /(?:window\.)?location\.href\s*=\s*["'](\/[^"']*)["']|window\.location\s*=\s*["'](\/[^"']*)["']|location\.(?:assign|replace)\(\s*["'](\/[^"']*)["']/
const isTest = (f) => /(\.test\.|\.spec\.|__tests__|__mocks__)/.test(f)

const violations = []
function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === 'dist') continue
    const p = join(dir, e)
    statSync(p).isDirectory() ? walk(p) : scan(p)
  }
}
function scan(file) {
  const ext = extname(file)
  if (!['.tsx', '.ts', '.jsx', '.js', '.css'].includes(ext)) return
  const lines = readFileSync(file, 'utf8').split('\n')
  if (file.includes('/components/ui/') && ext === '.tsx' && FORK_NAMES.has(basename(file, '.tsx'))) {
    violations.push(`${file}:1  forked DS primitive '${basename(file, '.tsx')}' — re-export from @niyi/ui instead of forking`)
  }
  let lastTag = null // most recent opening tag name (for raw <a>/<form> vs <Link> discrimination)
  const navEligible = !isTest(file) && ext !== '.css'
  lines.forEach((raw, i) => {
    const n = i + 1
    if (ext === '.css') {
      if (/@import[^;]*fonts\.googleapis/.test(raw) && OFF_FONTS.test(raw)) violations.push(`${file}:${n}  off-brand font @import — only Plus Jakarta Sans / DM Serif Display / JetBrains Mono`)
      if (/font-family/.test(raw) && OFF_FONTS.test(raw)) violations.push(`${file}:${n}  off-brand font-family`)
      return
    }
    const line = raw.replace(/\/\/.*$/, '') // strip line comments (avoids flagging `// neutral-700`)
    if (PALETTE.test(line)) violations.push(`${file}:${n}  raw palette class — use a semantic token (ink/muted/line/surface/canvas/primary/success/warning/error)`)
    if (FONT_PX.test(line)) violations.push(`${file}:${n}  arbitrary font px — use text-xs/sm/base/lg/...`)
    if (navEligible) {
      let m
      const tagRe = new RegExp(NAV_TAG_OPEN.source, 'g')
      while ((m = tagRe.exec(raw))) lastTag = m[1] // last opening tag on this line wins
      const ha = HREF_ACTION.exec(raw)
      if (ha && (lastTag === 'a' || lastTag === 'form') && isUnsafePath(ha[1])) {
        violations.push(`${file}:${n}  basePath-unsafe <${lastTag}> path "${ha[1]}" drops '${BASE_PATH}' and 404s — use next/link <Link> (auto-prefixed) or prefix the basePath`)
      }
      const lm = LOC_ASSIGN.exec(raw)
      if (lm) {
        const p = lm[1] || lm[2] || lm[3]
        if (isUnsafePath(p)) violations.push(`${file}:${n}  basePath-unsafe location nav to "${p}" drops '${BASE_PATH}' and 404s — use router.push (auto-prefixed)`)
      }
    }
  })
}
walk(ROOT)
if (violations.length) {
  console.error(`\n✗ design-guard: ${violations.length} violation(s)\n\n${violations.join('\n')}\n`)
  process.exit(1)
}
console.log('✓ design-guard: clean — adheres to the Pulse design system')
