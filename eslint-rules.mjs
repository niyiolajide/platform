import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const schedulerPackages = new Set(['node-cron', 'cron', 'node-schedule', 'agenda'])
const siblingUrlPattern =
  /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|host\.docker\.internal):(?:3000|3001|3003|3004|3005|3007|3008|3009|4000)\b/
const siblingServicePattern =
  /https?:\/\/(?:finpulse|healthpulse|lifepulse|homepulse|wisdompulse|photopulse|retirementpulse|propertypulse|controlplane|auth-service|hub|web)(?::|\/)/

function filenameOf(context) {
  return context.filename || context.getFilename()
}

function normalizePath(file) {
  return file.replaceAll('\\', '/')
}

function keyName(node) {
  if (!node) {return null}
  if (node.type === 'Identifier') {return node.name}
  if (node.type === 'Literal') {return String(node.value)}
  return null
}

function literalValue(node) {
  if (!node) {return null}
  if (node.type === 'Literal' && typeof node.value === 'string') {return node.value}
  if (node.type === 'TemplateElement') {return node.value.raw}
  return null
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value))
}

let packageNameCache
function packageName() {
  if (packageNameCache !== undefined) {return packageNameCache}
  const packageFile = join(process.cwd(), 'package.json')
  if (!existsSync(packageFile)) {
    packageNameCache = null
    return packageNameCache
  }
  try {
    const raw = JSON.parse(readFileSync(packageFile, 'utf8'))
    packageNameCache = typeof raw.name === 'string' ? raw.name : null
  } catch {
    packageNameCache = null
  }
  return packageNameCache
}

function configuredPatterns(context, defaults) {
  return [
    ...defaults,
    ...((context.options[0]?.allowFiles || []).map((raw) => new RegExp(raw))),
  ]
}

function isAllowedSiblingUrlFile(context) {
  const file = normalizePath(filenameOf(context))
  return matchesAny(configuredPatterns(context, [
    /(^|\/)(README|CLAUDE|MEMORY|TODO).*\.md$/i,
    /(^|\/)(package-lock|yarn\.lock|pnpm-lock)\b/,
    /(^|\/)(__tests__|test|tests|fixtures)(\/|$)/,
    /\.(test|spec)\.[cm]?[jt]sx?$/,
    /(^|\/)(next|jest|vitest|tailwind|postcss|eslint)\.config\.[cm]?[jt]s$/,
    /(^|\/)src\/lib\/config(\/|\.ts$)/,
    /(^|\/)src\/.*\/config(\/|\.ts$)/,
    /(^|\/)src\/edge\/index\.ts$/,
    /(^|\/)docker-compose.*\.ya?ml$/,
  ]), file)
}

function isAllowedSchedulerFile(context) {
  const file = normalizePath(filenameOf(context))
  if (packageName() === 'controlplane' && /(^|\/)src\/worker\/scheduler\.ts$/.test(file)) {return true}
  return matchesAny(configuredPatterns(context, [
    /\/controlplane\/src\/worker\/scheduler\.ts$/,
    /\/homepulse\//,
    /(^|\/)(__tests__|test|tests|fixtures)(\/|$)/,
    /\.(test|spec)\.[cm]?[jt]sx?$/,
  ]), file)
}

function hasRepeatSchedule(node) {
  return node.properties?.some((prop) => {
    if (prop.type !== 'Property' || keyName(prop.key) !== 'repeat') {return false}
    if (prop.value.type !== 'ObjectExpression') {return true}
    return prop.value.properties.some((repeatProp) => {
      return repeatProp.type === 'Property' && ['cron', 'every'].includes(keyName(repeatProp.key))
    })
  })
}

function isCronScheduleCall(node) {
  const callee = node.callee
  return callee.type === 'MemberExpression' && keyName(callee.property) === 'schedule'
}

function isServerIntervalFile(context) {
  const file = normalizePath(filenameOf(context))
  return /\/src\/(jobs|worker|server|lib\/middleware)\//.test(file) || /\/(queue|scheduler)\.[cm]?[jt]s$/.test(file)
}

function isHeartbeatInterval(context, node) {
  const text = context.sourceCode.getText(node.arguments[0] || node)
  return /heartbeat|updateHeartbeat/i.test(text)
}

function isClientProgram(node) {
  for (const item of node.body) {
    if (item.type !== 'ExpressionStatement') {return false}
    if (item.expression.type !== 'Literal') {return false}
    if (item.expression.value === 'use client') {return true}
  }
  return false
}

function envName(node) {
  if (node.type !== 'MemberExpression') {return null}
  const object = node.object
  if (object.type !== 'MemberExpression') {return null}
  if (object.object.type !== 'Identifier' || object.object.name !== 'process') {return null}
  if (keyName(object.property) !== 'env') {return null}
  return keyName(node.property)
}

function isForbiddenClientImport(source) {
  return (
    /^(node:)?(fs|crypto|child_process|net|tls)$/.test(source) ||
    source === '@prisma/client' ||
    /(^|\/)(prisma|server-only|service-token|secret|secrets)(\/|$)/.test(source)
  )
}

const noHardcodedSiblingUrl = {
  meta: {
    type: 'problem',
    docs: { description: 'forbid hardcoded sibling app URLs and local app ports' },
    schema: [{ type: 'object', properties: { allowFiles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: { hardcodedUrl: 'Use the control/app registry or validated env config instead of hardcoding sibling app URLs or ports.' },
  },
  create(context) {
    function check(node) {
      if (isAllowedSiblingUrlFile(context)) {return}
      const value = literalValue(node)
      if (value && (siblingUrlPattern.test(value) || siblingServicePattern.test(value))) {
        context.report({ node, messageId: 'hardcodedUrl' })
      }
    }
    return { Literal: check, TemplateElement: check }
  },
}

const noAppLocalScheduler = {
  meta: {
    type: 'problem',
    docs: { description: 'forbid recurring app-local schedulers outside ControlPlane and documented exceptions' },
    schema: [{ type: 'object', properties: { allowFiles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: { scheduler: 'Recurring jobs must be registered in ControlPlane, not scheduled inside the app.' },
  },
  create(context) {
    function report(node) {
      if (!isAllowedSchedulerFile(context)) {context.report({ node, messageId: 'scheduler' })}
    }
    return {
      ImportDeclaration(node) {
        if (schedulerPackages.has(String(node.source.value))) {report(node.source)}
      },
      CallExpression(node) {
        if (isCronScheduleCall(node)) {report(node.callee)}
        if (node.callee.type === 'Identifier' && node.callee.name === 'setInterval' && isServerIntervalFile(context) && !isHeartbeatInterval(context, node)) {report(node.callee)}
      },
      ObjectExpression(node) {
        if (hasRepeatSchedule(node)) {report(node)}
      },
    }
  },
}

const noClientServerSecretAccess = {
  meta: {
    type: 'problem',
    docs: { description: 'forbid server-only modules and secrets in client components' },
    schema: [],
    messages: {
      env: 'Client components may read only NEXT_PUBLIC_* environment variables.',
      import: 'Client components must not import server-only modules or secret-bearing code.',
    },
  },
  create(context) {
    let client = false
    return {
      Program(node) {
        client = isClientProgram(node)
      },
      ImportDeclaration(node) {
        if (client && isForbiddenClientImport(String(node.source.value))) {context.report({ node: node.source, messageId: 'import' })}
      },
      MemberExpression(node) {
        if (!client) {return}
        const name = envName(node)
        if (name && !name.startsWith('NEXT_PUBLIC_')) {context.report({ node, messageId: 'env' })}
      },
    }
  },
}

export const platformRules = {
  rules: {
    'no-app-local-scheduler': noAppLocalScheduler,
    'no-client-server-secret-access': noClientServerSecretAccess,
    'no-hardcoded-sibling-url': noHardcodedSiblingUrl,
  },
}
