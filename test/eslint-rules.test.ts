import { RuleTester } from 'eslint'
import { describe, expect, it } from 'vitest'
import { base } from '../eslint-config.mjs'
import { platformRules } from '../eslint-rules.mjs'

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

describe('platform ESLint rules', () => {
  it('rejects hardcoded sibling URLs outside config and tests', () => {
    tester.run('no-hardcoded-sibling-url', platformRules.rules['no-hardcoded-sibling-url'], {
      valid: [
        { code: "const url = 'http://host.docker.internal:3001'", filename: 'src/lib/config/env.ts' },
        { code: "const req = new Request('http://localhost:3000/api/test')", filename: '__tests__/route.test.ts' },
      ],
      invalid: [
        {
          code: "const url = 'http://host.docker.internal:3007/wisdom/api/health'",
          filename: 'src/lib/wisdom/client.ts',
          errors: [{ messageId: 'hardcodedUrl' }],
        },
        {
          code: "const url = `http://localhost:4000/api/status`",
          filename: 'src/components/Status.tsx',
          errors: [{ messageId: 'hardcodedUrl' }],
        },
      ],
    })
  })

  it('rejects app-local recurring schedulers', () => {
    tester.run('no-app-local-scheduler', platformRules.rules['no-app-local-scheduler'], {
      valid: [
        { code: "import cron from 'node-cron'\ncron.schedule('* * * * *', tick)", filename: '/repo/controlplane/src/worker/scheduler.ts' },
        { code: 'setInterval(updateHeartbeat, 30000)', filename: '/repo/finpulse/src/worker/index.ts' },
      ],
      invalid: [
        {
          code: "import cron from 'node-cron'\ncron.schedule('* * * * *', tick)",
          filename: '/repo/finpulse/src/worker/scheduler.ts',
          errors: [{ messageId: 'scheduler' }, { messageId: 'scheduler' }],
        },
        {
          code: "queue.add({}, { repeat: { cron: '* * * * *' } })",
          filename: '/repo/healthpulse/src/worker/queue.ts',
          errors: [{ messageId: 'scheduler' }],
        },
        {
          code: 'setInterval(runSync, 60000)',
          filename: '/repo/wisdompulse/src/jobs/registry.ts',
          errors: [{ messageId: 'scheduler' }],
        },
      ],
    })
  })

  it('rejects server secrets and modules in client components', () => {
    tester.run('no-client-server-secret-access', platformRules.rules['no-client-server-secret-access'], {
      valid: [
        { code: "'use client'\nconst id = process.env.NEXT_PUBLIC_APP_ID" },
        { code: "import { prisma } from '@/lib/prisma/client'\nconst secret = process.env.DATABASE_URL" },
      ],
      invalid: [
        {
          code: "'use client'\nimport { PrismaClient } from '@prisma/client'",
          errors: [{ messageId: 'import' }],
        },
        {
          code: "'use client'\nconst secret = process.env.DATABASE_URL",
          errors: [{ messageId: 'env' }],
        },
      ],
    })
  })

  it('enables invalidateQueries ownership with an empty default allowlist', () => {
    expect(base().some((config) => config.rules?.['pulse/no-discarded-invalidate-queries'] === 'error')).toBe(true)
  })

  it('rejects discarded invalidateQueries() promises independent of receiver', () => {
    tester.run('no-discarded-invalidate-queries', platformRules.rules['no-discarded-invalidate-queries'], {
      valid: [
        { code: 'async function run() { await receiver.invalidateQueries() }' },
        { code: 'function run() { return receiver.invalidateQueries() }' },
        { code: 'const run = () => receiver.invalidateQueries()' },
        { code: "async function run() { await receiver['invalidateQueries']() }" },
        { code: 'function run() { return clients.current.invalidateQueries() }' },
        {
          code: 'async function run() { await receiver.invalidateQueries().then(refetch).catch(onError) }',
        },
        { code: 'function run() { return receiver.invalidateQueries().then(refetch) }' },
        { code: 'async function run() { await receiver.invalidateQueries().catch(onError) }' },
        { code: 'async function run() { await receiver.invalidateQueries().finally(cleanup) }' },
        { code: 'function run() { return receiver.invalidateQueries().finally(cleanup) }' },
        { code: 'async function run() { await receiver?.invalidateQueries() }' },
        { code: 'async function run() { await (receiver?.invalidateQueries)() }' },
        { code: 'function run() { return receiver.invalidateQueries?.().catch(onError) }' },
        {
          code: 'async function run() { await Promise.all([a.invalidateQueries(), b.invalidateQueries()]) }',
        },
        { code: 'function run() { return Promise.all([a.invalidateQueries()]) }' },
        {
          code: 'function run() { return Promise.allSettled([a.invalidateQueries(), b.invalidateQueries()]) }',
        },
        { code: 'async function run() { await Promise.allSettled([a.invalidateQueries()]) }' },
        { code: 'async function run() { await Promise.race([a.invalidateQueries(), fallback()]) }' },
        { code: 'function run() { return Promise.race([a.invalidateQueries(), fallback()]) }' },
        { code: 'async function run() { await Promise.any([a.invalidateQueries(), b.invalidateQueries()]) }' },
        { code: 'function run() { return Promise.any([a.invalidateQueries(), b.invalidateQueries()]) }' },
        { code: 'async function run() { await Promise.all([a.invalidateQueries().catch(onError)]) }' },
        {
          // Documented limitation: syntax alone cannot tell whether an external
          // callback consumer (setTimeout here) honors the concise arrow's
          // implicit return; the arrow boundary alone makes this valid.
          code: 'setTimeout(() => receiver.invalidateQueries(), 0)',
        },
        {
          code: 'detachQueryRefresh(receiver.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh'] }],
        },
        {
          code: 'detachAccountsRefresh(receiver.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh', 'detachAccountsRefresh', 'detachNotificationsRefresh'] }],
        },
        {
          code: 'detachNotificationsRefresh(receiver?.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh', 'detachAccountsRefresh', 'detachNotificationsRefresh'] }],
        },
        {
          // Identifier text is intentionally trusted; binding identity is not resolved.
          code: 'function run(detachQueryRefresh) { detachQueryRefresh(receiver.invalidateQueries()) }',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh'] }],
        },
        { code: 'receiver.refetchQueries()' },
        { code: "receiver['invalidate' + 'Queries']()" },
        { code: 'const invalidate = receiver.invalidateQueries; invalidate()' },
      ],
      invalid: [
        {
          code: 'receiver.invalidateQueries()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'void receiver.invalidateQueries()',
          errors: [{ messageId: 'voidDiscardedInvalidate' }],
        },
        {
          code: 'queryClient.invalidateQueries()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'qc.invalidateQueries()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'this.props.queryClient.invalidateQueries()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'getClient().invalidateQueries()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: "receiver['invalidateQueries']()",
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'receiver?.invalidateQueries()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'receiver.invalidateQueries?.()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: '(receiver?.invalidateQueries)()',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          // Arrow boundary: block body is not an implicit return, pinned
          // against the valid concise-body case above.
          code: 'const run = () => { receiver.invalidateQueries() }',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'receiver.invalidateQueries().then(refetch).catch(onError)',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'receiver.invalidateQueries().catch(onError)',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'receiver.invalidateQueries().finally(cleanup)',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'Promise.all([a.invalidateQueries(), b.invalidateQueries()])',
          errors: [{ messageId: 'discardedInvalidate' }, { messageId: 'discardedInvalidate' }],
        },
        {
          code: 'someOtherFn(receiver.invalidateQueries())',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          // Default allowlist is empty: an unconfigured wrapper never audits a detach.
          code: 'detachQueryRefresh(receiver.invalidateQueries())',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          // Name must match exactly; a differently named configured wrapper does not audit this call.
          code: 'detachQueryRefresh(receiver.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detachAccountsRefresh'] }],
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'detachQueryRefresh(receiver.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detach*'] }],
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'refresh.detachQueryRefresh(receiver.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh'] }],
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          code: 'const detach = detachQueryRefresh; detach(receiver.invalidateQueries())',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh'] }],
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          // Must be a *direct* argument; reaching the wrapper through a .then chain does not qualify.
          code: 'detachQueryRefresh(receiver.invalidateQueries().then(refetch))',
          options: [{ auditedDetachFunctions: ['detachQueryRefresh'] }],
          errors: [{ messageId: 'discardedInvalidate' }],
        },
        {
          // Assignment-then-later-await dataflow is not tracked; always reported.
          code: 'async function run() { const p = receiver.invalidateQueries(); await p }',
          errors: [{ messageId: 'discardedInvalidate' }],
        },
      ],
    })
  })
})
