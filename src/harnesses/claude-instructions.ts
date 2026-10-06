import { join, resolve } from 'node:path';
import type { InstructionSource } from '../harness-kit.js';
import { Collector, userHomeOf } from './instruction-files.js';

/*
 * Claude Code in inherit mode loads the user-level CLAUDE.md from its configuration directory:
 * CLAUDE_CONFIG_DIR when set, otherwise $HOME/.claude. A configured CLAUDE_CONFIG_DIR replaces
 * $HOME/.claude rather than adding to it. Restricted calls load neither. Measured against Claude
 * Code 2.1.290 (2026-10-06) by the contract case claude-user-instructions in
 * test/harness-isolation-contract.mjs.
 *
 * Only that one file is detected. Project CLAUDE.md files (including <ancestor>/.claude/CLAUDE.md,
 * which loads even when the ancestor is HOME), CLAUDE.local.md, rules directories, @imports and
 * auto-memory are not. Detection is a diagnostic, never part of step identity.
 */

/** The Claude configuration directory a child with this environment resolves; empty values count as unset. @internal */
export function claudeConfigDirOf(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  if (configured) return configured;
  return join(userHomeOf(env), '.claude');
}

/** Inputs for the Claude instruction detector. @internal */
export interface ClaudeInstructionOptions {
  /** Resolved Claude configuration directory; a relative value resolves against `cwd`. */
  readonly configDir: string;
  /** Working directory of the Claude call. */
  readonly cwd: string;
  /** Cancellation; an abort rejects instead of becoming a warning. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Detect the user-level CLAUDE.md that an inherit-mode Claude call loads, as a path and digest. It
 * never follows @imports. Read problems become warnings; only an abort rejects. @internal
 */
export async function detectClaudeUserInstructionSources(
  options: ClaudeInstructionOptions,
): Promise<{
  readonly sources: readonly InstructionSource[];
  readonly warnings: readonly string[];
}> {
  const found = new Collector('Claude', options.signal);
  // Recorded even when blank: blank handling was not probed, so this errs toward recording.
  await found.add('user', 'claude-md', join(resolve(options.cwd, options.configDir), 'CLAUDE.md'));
  return { sources: found.sources, warnings: found.warnings };
}
