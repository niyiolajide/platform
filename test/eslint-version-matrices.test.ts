import { RuleTester as RuleTester8 } from 'eslint'
import { RuleTester as RuleTester9 } from 'eslint9'
import { describe, it } from 'vitest'
import { platformRules } from '../eslint-rules.mjs'

// The same custom pulse rule objects must execute under both the ESLint 8 and
// ESLint 9 harnesses: v8 RuleTester is constructed with eslintrc-style
// parserOptions while v9 RuleTester requires flat-config languageOptions.
type Tester = Pick<RuleTester8, 'run'>

const engines: { label: string; tester: Tester }[] = [
  {
    label: 'eslint8',
    tester: new RuleTester8({ parserOptions: { ecmaVersion: 2022, sourceType: 'module' } }),
  },
  {
    label: 'eslint9',
    tester: new RuleTester9({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } }),
  },
]

type Engine = (typeof engines)[number]

function schedulerCases(engine: Engine) {
  describe(`no-app-local-scheduler (${engine.label})`, () => {
    it('allows the ControlPlane scheduler and heartbeat intervals', () => {
      engine.tester.run('no-app-local-scheduler', platformRules.rules['no-app-local-scheduler'], {
        valid: [
          {
            code: "import cron from 'node-cron'\ncron.schedule('* * * * *', tick)",
            filename: '/repo/controlplane/src/worker/scheduler.ts',
          },
          {
            code: 'function updateHeartbeat() {}\nsetInterval(updateHeartbeat, 1000)',
            filename: '/repo/app/src/worker/index.js',
          },
          {
            code: "import cron from 'node-cron'\ncron.schedule('* * * * *', tick)",
            filename: '/repo/app/src/worker/scheduler.ts',
            options: [{ allowFiles: ['scheduler\\.ts$'] }],
          },
        ],
        invalid: [],
      })
    })

    it('rejects recurring schedulers in app files', () => {
      engine.tester.run('no-app-local-scheduler', platformRules.rules['no-app-local-scheduler'], {
        valid: [],
        invalid: [
          {
            code: "import cron from 'node-cron'\ncron.schedule('* * * * *', tick)",
            filename: '/repo/app/src/worker/scheduler.ts',
            errors: [{ messageId: 'scheduler' }, { messageId: 'scheduler' }],
          },
          {
            code: 'setInterval(runSync, 60000)',
            filename: '/repo/app/src/jobs/registry.js',
            errors: [{ messageId: 'scheduler' }],
          },
          {
            code: "queue.add({}, { repeat: { every: 5000 } })",
            filename: '/repo/app/src/worker/queue.js',
            errors: [{ messageId: 'scheduler' }],
          },
        ],
      })
    })
  })
}

function siblingUrlCases(engine: Engine) {
  describe(`no-hardcoded-sibling-url (${engine.label})`, () => {
    it('allows config, test and opted-in files', () => {
      engine.tester.run('no-hardcoded-sibling-url', platformRules.rules['no-hardcoded-sibling-url'], {
        valid: [
          { code: "const url = 'http://localhost:3000/api/health'", filename: 'src/lib/config/env.ts' },
          { code: "fetch('http://localhost:4000/api/status')", filename: '/repo/app/src/lib/probe.test.ts' },
          {
            code: "const url = 'http://localhost:4000/api/status'",
            filename: '/repo/app/src/lib/legacy.ts',
            options: [{ allowFiles: ['legacy\\.ts$'] }],
          },
        ],
        invalid: [],
      })
    })

    it('rejects hardcoded sibling ports, service hosts and templates', () => {
      engine.tester.run('no-hardcoded-sibling-url', platformRules.rules['no-hardcoded-sibling-url'], {
        valid: [],
        invalid: [
          {
            code: "const url = 'http://localhost:4000/api/status'",
            filename: '/repo/app/src/components/Status.ts',
            errors: [{ messageId: 'hardcodedUrl' }],
          },
          {
            code: 'const url = `https://finpulse/internal/sync`',
            filename: '/repo/app/src/lib/sync.ts',
            errors: [{ messageId: 'hardcodedUrl' }],
          },
        ],
      })
    })
  })
}

function clientSecretCases(engine: Engine) {
  describe(`no-client-server-secret-access (${engine.label})`, () => {
    it('allows public env in clients and secrets on the server', () => {
      engine.tester.run(
        'no-client-server-secret-access',
        platformRules.rules['no-client-server-secret-access'],
        {
          valid: [
            { code: "'use client'\nconst id = process.env.NEXT_PUBLIC_APP_ID" },
            { code: "import fs from 'node:fs'\nconst secret = process.env.DATABASE_URL" },
          ],
          invalid: [],
        },
      )
    })

    it('rejects server modules and non-public env in clients', () => {
      engine.tester.run(
        'no-client-server-secret-access',
        platformRules.rules['no-client-server-secret-access'],
        {
          valid: [],
          invalid: [
            {
              code: "'use client'\nimport { PrismaClient } from '@prisma/client'",
              errors: [{ messageId: 'import' }],
            },
            {
              code: "'use client'\nconst secret = process.env.SECRET_TOKEN",
              errors: [{ messageId: 'env' }],
            },
          ],
        },
      )
    })
  })
}

describe('platform rules across ESLint 8 and 9 harnesses', () => {
  for (const engine of engines) {
    schedulerCases(engine)
    siblingUrlCases(engine)
    clientSecretCases(engine)
  }
})
