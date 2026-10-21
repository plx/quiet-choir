import { defineRoster } from 'quiet-choir';

// Data only. One entry per harness: a role that served both harnesses is split in two, and the
// Claude-only limits (maxTurns, maxBudgetUsd) stay off the Codex entry.
const Reader = {
  harness: 'claude',
  description: 'Reads the repository and returns structured findings; never edits.',
  tools: ['Read', 'Grep', 'Glob'],
  allowedTools: ['Read', 'Grep', 'Glob'],
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 300_000,
} as const;

const CodexReader = {
  harness: 'codex',
  description: 'Reads the repository through a read-only sandbox; never edits.',
  sandbox: 'read-only',
  timeoutMs: 300_000,
} as const;

const Writer = {
  harness: 'claude',
  description: 'Edits files inside a managed checkout; code runs verification.',
  tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
  allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
  maxTurns: 40,
  maxBudgetUsd: 5,
  timeoutMs: 600_000,
} as const;

// A roster cannot be subset, so the read-only ports declare their own, smaller inventory.
export const readers = defineRoster({ Reader, CodexReader });
export const roster = defineRoster({ Reader, CodexReader, Writer });
