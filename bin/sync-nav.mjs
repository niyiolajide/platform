#!/usr/bin/env node
// pulse-sync-nav — generate an app's in-repo fallback nav from control/apps.json
// (the single nav source-of-truth), the web equivalent of pulse-mobile's
// scripts/sync-apps.mjs. Kills the hand-maintained-fallback drift class (R2,
// REVIEW-20260702-003/A-002).
//
// The generated file exports the app's raw registry nav entries (CONTROL_NAV),
// web-surface filtered; the app adapts that to its local fallback shape with
// its existing mapper. DO NOT hand-edit the generated file — re-run this tool.
//
// No host node is required: run it from the platform checkout inside Docker,
// from the app repo root, e.g.
//   docker run --rm -v /Users/niyi/scripts:/ws -w /ws/<app> node:20 \
//     node ../platform/bin/sync-nav.mjs --app <key>
//
// Usage:
//   pulse-sync-nav --app <key> [--control <apps.json>] [--out <file>] [--check]
//     --app      app key in control/apps.json (required)
//     --control  path to apps.json            (default ../control/apps.json)
//     --out      generated TS file            (default src/lib/nav.generated.ts)
//     --check    verify --out is up to date; exit 1 and write nothing if stale
import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {return fallback}
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {return fallback}
  return value
}

const CHECK = process.argv.includes('--check')
const APP = arg('app')
const CONTROL = path.resolve(arg('control', path.join('..', 'control', 'apps.json')))
const OUT = path.resolve(arg('out', path.join('src', 'lib', 'nav.generated.ts')))

if (!APP) {
  console.error('pulse-sync-nav: --app <key> is required')
  process.exit(2)
}

let control
try {
  control = JSON.parse(fs.readFileSync(CONTROL, 'utf8'))
} catch (error) {
  console.error(`pulse-sync-nav: cannot read control registry at ${CONTROL}: ${String(error)}`)
  process.exit(2)
}

const app = (control.apps ?? []).find((candidate) => candidate.key === APP)
if (!app) {
  console.error(`pulse-sync-nav: app "${APP}" not found in ${CONTROL}`)
  process.exit(2)
}
const nav = Array.isArray(app.nav) ? app.nav : []
if (nav.length === 0) {
  console.error(`pulse-sync-nav: app "${APP}" has no nav array in ${CONTROL} — refusing to generate an empty fallback`)
  process.exit(2)
}

// A nav item is part of the WEB fallback unless it explicitly opts out via a
// `surfaces` array that excludes 'web'. Items without `surfaces` are included
// (matches pulse-mobile's opt-in semantics for apps predating surface flags).
const onWeb = (item) => !Array.isArray(item.surfaces) || item.surfaces.includes('web')

// Stable field order so regeneration is deterministic and --check is a plain
// string comparison.
function serializeItem(item) {
  const fields = []
  const put = (key, value) => {
    if (value === undefined || value === null) {return}
    fields.push(`${key}: ${JSON.stringify(value)}`)
  }
  put('key', item.key)
  put('label', item.label)
  put('href', item.href)
  put('icon', item.icon)
  put('group', item.group)
  put('frequencyRank', item.frequencyRank)
  if (Array.isArray(item.surfaces)) {put('surfaces', item.surfaces)}
  return `  { ${fields.join(', ')} },`
}

const items = nav.filter(onWeb)
const body = items.map(serializeItem).join('\n')
const generated = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Fallback nav for "${APP}", generated from control/apps.json (the single nav
// source-of-truth) by @niyi/platform's pulse-sync-nav. The app's runtime nav
// still comes from readApps(); this constant is only the offline fallback.
// Regenerate (from the app repo root, Docker; no host node):
//   docker run --rm -v /Users/niyi/scripts:/ws -w /ws/$(basename $PWD) node:20 \\
//     node ../platform/bin/sync-nav.mjs --app ${APP}

export interface ControlNavEntry {
  key?: string
  label: string
  href: string
  icon?: string
  group?: string
  frequencyRank?: number
  surfaces?: string[]
}

export const CONTROL_NAV: ControlNavEntry[] = [
${body}
]
`

const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null
if (CHECK) {
  if (current === generated) {
    console.log(`pulse-sync-nav: ${path.relative(process.cwd(), OUT)} is up to date (${items.length} items)`)
    process.exit(0)
  }
  console.error(`pulse-sync-nav: ${path.relative(process.cwd(), OUT)} is STALE vs ${CONTROL} — re-run pulse-sync-nav --app ${APP}`)
  process.exit(1)
}

if (current === generated) {
  console.log(`pulse-sync-nav: ${path.relative(process.cwd(), OUT)} already up to date (${items.length} items)`)
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, generated)
  console.log(`pulse-sync-nav: wrote ${path.relative(process.cwd(), OUT)} (${items.length} items)`)
}
