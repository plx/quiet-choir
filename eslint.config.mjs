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
      'src/workflow/runtime/recovery-hint.ts',
      'src/workflow/loader/start-readiness.ts',
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
                'Pure decision modules (ADR 0007 attempt failures, replay decisions, recovery decisions, recovery hints, start readiness) must stay free of I/O: import values only from ./step-error.js and ./configuration-error.js; everything else must be import type.',
            },
          ],
        },
      ],
    },
  },
  {
    // Worktree policy validation and capture planning: pure, so both table-test without Git, and
    // the policy validator stays free of the run store that workflow type checks must not load.
    files: ['src/workflow/runtime/worktree-policy.ts', 'src/workflow/runtime/worktree-capture.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**'],
              allowTypeImports: true,
              message:
                'Worktree policy and capture helpers must stay free of I/O and the run store: use import type only.',
            },
          ],
        },
      ],
    },
  },
  {
    // The pending row selection: a pure function of listed rows and recorded launches.
    files: ['src/workflow/loader/pending-listing.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**', '!./next-commands.js'],
              allowTypeImports: true,
              message:
                'The pending row selection must stay free of I/O: import values only from ./next-commands.js; everything else must be import type.',
            },
          ],
        },
      ],
    },
  },
  {
    // The event line formatter and the record follower's derivation: no I/O, clock or store, so
    // `--events` and `workflow events` share one pure line shape.
    files: ['src/workflow/loader/event-line.ts', 'src/workflow/loader/event-follow.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**', '!./event-line.js'],
              allowTypeImports: true,
              message:
                'Event line modules must stay free of I/O: import values only from ./event-line.js; everything else must be import type.',
            },
          ],
        },
      ],
    },
  },
  {
    // The durability lint (ADR 0041): a pure function of a compiler program. It may import the
    // TypeScript compiler API; everything else must be `import type`.
    files: ['src/workflow/typecheck/durability-lint.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**'],
              allowTypeImports: true,
              message:
                'The durability lint must stay free of I/O: import values only from typescript; everything else must be import type.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The durability lint must not read the process.' },
        { name: 'Date', message: 'The durability lint must not read the clock.' },
      ],
    },
  },
  prettier,
);
