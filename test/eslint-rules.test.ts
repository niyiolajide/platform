import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
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
})
