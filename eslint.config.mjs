import { node } from './eslint-config.mjs'

export default [
  ...node(),
  {
    files: ['vitest.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'], defaultProject: 'tsconfig.eslint.json' },
        tsconfigRootDir: process.cwd(),
      },
    },
  },
]
