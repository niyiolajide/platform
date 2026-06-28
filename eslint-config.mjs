import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Pulse platform guardrail config (flat). Constrains complexity/over-engineering and
// catches common generation bugs. Two rules from the source spec were intentionally
// dropped for this codebase: `quotes: double` (the codebase is single-quote) and
// `tailwindcss/no-custom-classname` (it rejects the @niyi/ui design-system classes).
// Token/palette drift + basePath-unsafe nav are enforced separately by scripts/design-guard.mjs.
export default [
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/*.config.{js,mjs,cjs}",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: reactPlugin,
      // Registered so existing `eslint-disable react-hooks/*` directives resolve
      // (eslint-config-next emits them); its rules are not enabled here.
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      // no-undef needs runtime globals declared, plus the TS/Next ambient type
      // globals (React/JSX/NodeJS) so it doesn't false-positive on type-only refs.
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        React: "readonly",
        JSX: "readonly",
        NodeJS: "readonly",
      },
    },
    settings: { react: { version: "detect" } },
    rules: {
      /* 1. Anti-overengineering & complexity limits.
         Hard errors: all apps that adopt this shared config must split large,
         deeply nested, or wide-argument modules before they land. */
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 250, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", { max: 4 }],
      "max-depth": ["error", { max: 3 }],
      "max-nested-callbacks": ["error", { max: 2 }],

      /* 2. Styling-bug guard (raw colors; token drift handled by design-guard.mjs) */
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/hover:-translate/]",
          message: "Do not use hover transitions that translate layout positions. They trigger jitter loops. Use shadow or opacity transitions instead.",
        },
        {
          selector: "JSXAttribute[name.name='className'] Literal[value=/bg-(white|gray|black)/]",
          message: "Do not hardcode raw colors. Use semantic tokens (e.g. bg-surface/bg-canvas) to preserve dark mode.",
        },
      ],

      /* 3. Syntax & compilation safety */
      "react/jsx-no-comment-textnodes": "error",
      "no-irregular-whitespace": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    // TypeScript already checks for undefined references, and `no-undef` mis-flags
    // type-only globals (RequestInit, React, JSX, NodeJS…). Disable it for TS and
    // let tsc own that check; keep it on for plain .js/.jsx (handled above).
    files: ["**/*.{ts,tsx}"],
    rules: { "no-undef": "off" },
  },
];
