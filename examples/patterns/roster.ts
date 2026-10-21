import { defineRoster } from '../../src/index.js';

// Data only: the agents these recipes call. Each recipe takes the one-entry roster it needs, so
// `--require-grants` asks for no grant on an entry the recipe never calls.
export const readerRoster = defineRoster({
  Reader: {
    harness: 'claude',
    description: 'Reads files and answers; never edits.',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
  },
});

export const editorRoster = defineRoster({
  Editor: {
    harness: 'claude',
    description: 'Edits files in the working tree.',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
  },
});

export const codexReaderRoster = defineRoster({
  CodexReader: {
    harness: 'codex',
    description: 'Reads through a read-only sandbox.',
    sandbox: 'read-only',
    timeoutMs: 900_000,
  },
});

export const codexEditorRoster = defineRoster({
  CodexEditor: {
    harness: 'codex',
    description: 'Edits files in a workspace-write sandbox.',
    sandbox: 'workspace-write',
    timeoutMs: 1_800_000,
  },
});
