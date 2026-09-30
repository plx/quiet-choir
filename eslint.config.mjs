import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // Comparison snapshots use their own migration tsconfig and fixture checks. Claude Code
    // workflow scripts are bodies of an async function (top-level `return`), not modules.
    ignores: [
      '.claude/workflows/*.js',
      '.quiet-choir/**',
      '.context/**',
      'coverage/**',
      'dist/**',
      'docs/api/**',
      'comparisons/batches/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': [
        'error',
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['**/*.{cjs,js,mjs}'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['comparisons/site/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/integrations/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../**', './**', '!../index.js'],
              message:
                'Integration helpers must use the public quiet-choir entry point, not runtime internals.',
            },
          ],
        },
      ],
    },
  },
  {
    // Pure decision modules: no I/O, clock or store. Values come only from the two allowlisted
    // siblings; everything else must be `import type`.
    files: [
      'src/workflow/runtime/attempt-failure.ts',
      'src/workflow/runtime/replay-decision.ts',
      'src/workflow/runtime/recovery-decision.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                ...builtinModules,
                './**',
                '../**',
                '!./step-error.js',
                '!./configuration-error.js',
              ],
              allowTypeImports: true,
              message:
                'Pure decision modules (ADR 0007 attempt failures, replay decisions, recovery decisions) must stay free of I/O: import values only from ./step-error.js and ./configuration-error.js; everything else must be import type.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
