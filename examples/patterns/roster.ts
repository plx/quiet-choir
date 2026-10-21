import { defineRoster } from '../../src/index.js';

// Data only: the agents these recipes call, one entry per harness.
export const roster = defineRoster({
  Reader: {
    harness: 'claude',
    description: 'Reads files and answers; never edits.',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
  },
  Editor: {
    harness: 'claude',
    description: 'Edits files in the working tree.',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
  },
  CodexReader: {
    harness: 'codex',
    description: 'Reads through a read-only sandbox.',
    sandbox: 'read-only',
    timeoutMs: 900_000,
  },
  CodexEditor: {
    harness: 'codex',
    description: 'Edits files in a workspace-write sandbox.',
    sandbox: 'workspace-write',
    timeoutMs: 1_800_000,
  },
});
