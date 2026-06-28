/* eslint-disable max-lines -- central shared policy file intentionally enumerates all rule layers and exported variants. */
import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import importPlugin from 'eslint-plugin-import'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import promisePlugin from 'eslint-plugin-promise'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactNative from 'eslint-plugin-react-native'
import securityPlugin from 'eslint-plugin-security'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { platformRules } from './eslint-rules.mjs'

const TS_FILES = ['**/*.{ts,tsx}']
const JS_TS_FILES = ['**/*.{js,jsx,ts,tsx,mjs,cjs}']
const JSX_FILES = ['**/*.{jsx,tsx}']
const TEST_FILES = ['**/*.{test,spec}.{js,jsx,ts,tsx}', '**/__tests__/**/*.{js,jsx,ts,tsx}', 'test/**/*.{js,jsx,ts,tsx}']
const CONFIG_FILES = ['**/*.{config,setup}.{js,cjs,mjs,ts}', 'eslint-*.mjs', 'design-guard.mjs']

const ignores = [
  '**/.next/**',
  '**/.expo/**',
  '**/android/**',
  '**/build/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/prisma/generated/**',
  '**/generated/**',
  '**/_archived*/**',
  'next-env.d.ts',
]

const complexityRules = {
  'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
  'max-lines': ['error', { max: 250, skipBlankLines: true, skipComments: true }],
  'max-params': ['error', { max: 4 }],
  'max-depth': ['error', { max: 3 }],
  'max-nested-callbacks': ['error', { max: 2 }],
}

const coreRules = {
  ...complexityRules,
  'array-callback-return': 'error',
  curly: ['error', 'all'],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-duplicate-imports': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-implicit-coercion': 'error',
  'no-irregular-whitespace': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'no-throw-literal': 'error',
  'no-undef': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-vars': 'off',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'react/jsx-no-comment-textnodes': 'error',
}

const designRules = {
  'no-restricted-imports': ['error', {
    patterns: [{
      group: ['*/components/ui/Button', '*/components/ui/Card', '*/components/ui/Input', '*/components/ui/Badge'],
      message: 'Import shared primitives from @niyi/ui, not a local copy.',
    }],
  }],
  'no-restricted-syntax': ['error',
    {
      selector: "JSXAttribute[name.name='style']",
      message: 'Avoid inline style={{}}; use @niyi/ui primitives and semantic tokens. Charts and computed dimensions need a documented exception.',
    },
    {
      selector: "JSXAttribute[name.name='className'] Literal[value=/hover:-translate/]",
      message: 'Do not use hover transitions that translate layout positions. Use shadow or opacity transitions instead.',
    },
    {
      selector: "JSXAttribute[name.name='className'] Literal[value=/bg-(white|gray|black)/]",
      message: 'Do not hardcode raw colors. Use semantic tokens such as bg-surface or bg-canvas.',
    },
  ],
}

const typedRuleOverrides = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/consistent-type-exports': 'error',
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
  '@typescript-eslint/no-base-to-string': 'error',
  '@typescript-eslint/no-duplicate-type-constituents': 'error',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
  '@typescript-eslint/no-unnecessary-condition': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': 'error',
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/require-await': 'error',
  '@typescript-eslint/restrict-plus-operands': 'error',
  '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
  '@typescript-eslint/return-await': ['error', 'always'],
  '@typescript-eslint/strict-boolean-expressions': ['error', {
    allowNullableBoolean: true,
    allowNullableNumber: true,
    allowNullableObject: true,
    allowNullableString: true,
    allowNumber: true,
    allowString: true,
  }],
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
}

const securityRules = {
  ...Object.fromEntries(Object.entries(securityPlugin.configs.recommended.rules).map(([rule]) => [rule, 'error'])),
  // These heuristics are too broad for validated file-bus, schema parsing, and
  // scraper code. Core no-eval/no-implied-eval/no-new-func plus custom platform
  // rules cover the actionable hazards without blocking legitimate dynamic keys.
  'security/detect-non-literal-fs-filename': 'off',
  'security/detect-non-literal-regexp': 'off',
  'security/detect-object-injection': 'off',
  'security/detect-unsafe-regex': 'off',
}

function typedConfigs() {
  return tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: TS_FILES,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        projectService: { allowDefaultProject: ['*.mjs', '*.ts', 'test/*.ts'], defaultProject: 'tsconfig.eslint.json' },
        tsconfigRootDir: process.cwd(),
      },
    },
  }))
}

function baseLanguage() {
  return {
    files: JS_TS_FILES,
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
      promise: promisePlugin,
      react: reactPlugin,
      'react-hooks': reactHooks,
      security: securityPlugin,
      pulse: platformRules,
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node, ...globals.es2022, React: 'readonly', JSX: 'readonly', NodeJS: 'readonly' },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...coreRules,
      ...designRules,
      ...securityRules,
      ...promisePlugin.configs['flat/recommended'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'import/first': 'error',
      'import/no-cycle': ['error', { maxDepth: 1 }],
      'import/no-duplicates': 'error',
      'import/no-self-import': 'error',
      'pulse/no-hardcoded-sibling-url': 'error',
    },
  }
}

function tsOverride() {
  return {
    files: TS_FILES,
    rules: { ...typedRuleOverrides, 'no-undef': 'off' },
  }
}

function testOverride() {
  return {
    files: TEST_FILES,
    languageOptions: { globals: { ...globals.jest, ...globals.vitest } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'max-lines-per-function': 'off',
    },
  }
}

function configFileOverride() {
  return {
    files: CONFIG_FILES,
    languageOptions: { sourceType: 'module', globals: globals.node },
    rules: {
      'import/no-cycle': 'off',
      'pulse/no-hardcoded-sibling-url': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-regexp': 'off',
      'security/detect-unsafe-regex': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  }
}

export function base() {
  return [
    { linterOptions: { reportUnusedDisableDirectives: 'error' } },
    { ignores },
    js.configs.recommended,
    baseLanguage(),
    ...typedConfigs(),
    tsOverride(),
    testOverride(),
    configFileOverride(),
  ]
}

export function next() {
  return [
    ...base(),
    {
      files: JSX_FILES,
      plugins: { '@next/next': nextPlugin, 'jsx-a11y': jsxA11y },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
        ...(jsxA11y.flatConfigs?.strict?.rules || jsxA11y.configs.strict.rules),
        ...reactHooks.configs.recommended.rules,
        'pulse/no-client-server-secret-access': 'error',
      },
    },
    {
      files: ['src/jobs/**/*.{ts,tsx}', 'src/worker/**/*.{ts,tsx}', 'src/app/api/**/*.{ts,tsx}', 'scripts/**/*.{ts,tsx,js,mjs}'],
      rules: { 'pulse/no-app-local-scheduler': 'error' },
    },
  ]
}

export function node() {
  return [
    ...base(),
    {
      files: ['src/**/*.{ts,js,mjs,cjs}', 'scripts/**/*.{ts,js,mjs,cjs}'],
      rules: { 'pulse/no-app-local-scheduler': 'error' },
    },
  ]
}

export function native() {
  return [
    ...base(),
    {
      files: ['**/*.{tsx,jsx}'],
      plugins: { 'react-native': reactNative },
      rules: {
        ...reactHooks.configs.recommended.rules,
        'react-native/no-inline-styles': 'error',
        'react-native/no-color-literals': 'error',
      },
    },
  ]
}

export default next()
