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
      'vitest-reports/**',
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
              // A regex, because a gitignore group cannot re-include a file below an excluded
              // directory such as ../workflow/.
              regex:
                '^(?:\\./(?!github-model\\.js$|github-epic-model\\.js$|github-wait-model\\.js$|github-write-model\\.js$|github-writes\\.js$)|\\.\\./(?!index\\.js$|workflow/runtime/error-brand\\.js$|workflow/runtime/poll-identity\\.js$))',
              message:
                'Integration helpers must use the public quiet-choir entry point, not runtime internals. The exceptions are their own pure ./github-model.js, ./github-epic-model.js, ./github-wait-model.js and ./github-write-model.js, the writes module ./github-writes.js, the error-brand registry (ADR 0028) and the poll-identity key (ADR 0045): cross-instance contracts, not runtime state.',
            },
          ],
        },
      ],
    },
  },
  {
    // The pure parts of quiet-choir/github: queries, schemas and mappers (ADR 0044) and the wait
    // rules (ADR 0045). Values come only from the public entry point; no I/O, clock or process.
    files: ['src/integrations/github-model.ts', 'src/integrations/github-wait-model.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**', '!../index.js'],
              allowTypeImports: true,
              message:
                'The GitHub read and wait models must stay free of I/O: import values only from ../index.js; everything else must be import type.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The GitHub read and wait models must not read the process.' },
        { name: 'Date', message: 'The GitHub read and wait models must not read the clock.' },
      ],
    },
  },
  {
    // The pure parts of the reconciled GitHub writes (ADR 0046): marker, request builders, schemas
    // and decisions. Values come only from the public entry point and the pure read model.
    files: ['src/integrations/github-write-model.ts'],
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
                '!../index.js',
                '!./github-model.js',
              ],
              allowTypeImports: true,
              message:
                'The GitHub write model must stay free of I/O: import values only from ../index.js and ./github-model.js; everything else must be import type.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The GitHub write model must not read the process.' },
        { name: 'Date', message: 'The GitHub write model must not read the clock.' },
      ],
    },
  },
  {
    // The pure epic snapshot and next-ticket selector (ADR 0048): query, schema, parsers, mapper
    // and selector. Values come only from the public entry point and the pure read model.
    files: ['src/integrations/github-epic-model.ts'],
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
                '!../index.js',
                '!./github-model.js',
              ],
              allowTypeImports: true,
              message:
                'The GitHub epic model must stay free of I/O: import values only from ../index.js and ./github-model.js; everything else must be import type.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The GitHub epic model must not read the process.' },
        { name: 'Date', message: 'The GitHub epic model must not read the clock.' },
      ],
    },
  },
  {
    // Pure decision modules: no I/O, clock or store. Values come only from the two allowlisted
    // siblings; everything else must be `import type`.
    files: [
      'src/workflow/runtime/attempt-failure.ts',
      'src/workflow/runtime/replay-decision.ts',
      'src/workflow/runtime/recovery-hint.ts',
      'src/workflow/runtime/harness-config-decision.ts',
      'src/workflow/runtime/launch-leftover-decision.ts',
      'src/workflow/loader/start-readiness.ts',
      'src/workflow/loader/prune-selection.ts',
      'src/workflow/loader/root-selection.ts',
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
                'Pure decision modules (ADR 0007 attempt failures, replay decisions, recovery decisions, recovery hints, harness configuration decisions, removal decisions, leftover launch directories, start readiness, prune selection, project-root selection) must stay free of I/O: import values only from ./step-error.js and ./configuration-error.js; everything else must be import type.',
            },
          ],
        },
      ],
    },
  },
  {
    // The removal and recovery decisions are pure too, but their messages embed launcher-correct
    // `workflow` commands, so they may also import values from the argv builders in ./commands.js,
    // which read no I/O, clock or store.
    files: [
      'src/workflow/runtime/removal-decision.ts',
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
                '!./commands.js',
              ],
              allowTypeImports: true,
              message:
                'The removal and recovery decisions must stay free of I/O: import values only from ./step-error.js, ./configuration-error.js and ./commands.js; everything else must be import type.',
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
    // The bounded step error text carried on step.failed and step.settled events: pure, so the
    // record follower can share it with the runner.
    files: ['src/workflow/runtime/step-event-error.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**'],
              allowTypeImports: true,
              message:
                'The step event error helper must stay free of I/O and the run store: use import type only.',
            },
          ],
        },
      ],
    },
  },
  {
    // Rate-limit windows: the stored shape, its validation and its formatting, shared by the stream
    // handler, the inspection summary and the text views.
    files: ['src/workflow/runtime/rate-limit.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules, './**', '../**'],
              allowTypeImports: true,
              message:
                'The rate-limit helpers must stay free of I/O and the run store: use import type only.',
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
    // `--events` and `workflow events` share one pure line shape. The pure rate-limit module
    // supplies the window gate's suspension message, which the runtime's notification also uses, and
    // the pure step-event-error module bounds the step error text the runner also puts on events.
    // failure-kind.ts supplies the recorded error kinds and the retryable flag.
    files: ['src/workflow/loader/event-line.ts', 'src/workflow/loader/event-follow.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules],
              allowTypeImports: true,
              message:
                'Event line modules must stay free of I/O: import values only from ./event-line.js, ./failure-kind.js and the pure ../runtime/rate-limit.js and ../runtime/step-event-error.js; everything else must be import type.',
            },
            {
              // A regex, because a gitignore group cannot re-include a file below ../runtime/.
              regex:
                '^(?:\\./(?!(?:event-line|failure-kind)\\.js$)|\\.\\./(?!runtime/(?:rate-limit|step-event-error)\\.js$))',
              allowTypeImports: true,
              message:
                'Event line modules must stay free of I/O: import values only from ./event-line.js, ./failure-kind.js and the pure ../runtime/rate-limit.js and ../runtime/step-event-error.js; everything else must be import type.',
            },
          ],
        },
      ],
    },
  },
  {
    // The failure kind helpers read stored kinds and compute `retryable`; the event line modules
    // import them, so they stay free of I/O. Only the pure transient-set lookup is a value import.
    files: ['src/workflow/loader/failure-kind.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...builtinModules],
              allowTypeImports: true,
              message:
                'The failure kind helpers must stay free of I/O: import values only from ../runtime/step-error.js; everything else must be import type.',
            },
            {
              // A regex, because a gitignore group cannot re-include a file below ../runtime/.
              regex: '^(?:\\./|\\.\\./(?!runtime/step-error\\.js$))',
              allowTypeImports: true,
              message:
                'The failure kind helpers must stay free of I/O: import values only from ../runtime/step-error.js; everything else must be import type.',
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
