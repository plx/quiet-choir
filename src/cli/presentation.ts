import { relative } from 'node:path';

import {
  formatDurabilityDiagnostic,
  type DurabilityDiagnostic,
  type TypecheckDiagnosticDetails,
} from '../workflow/typecheck/model.js';
import { formatArgv, type NextCommand } from '../workflow/loader/next-commands.js';

/** Render a normalized TypeScript diagnostic for a human. */
export function formatTypecheckDiagnostic(
  diagnostic: TypecheckDiagnosticDetails,
  workingDirectory: string,
): string {
  const location =
    diagnostic.filePath === null
      ? ''
      : `${relative(workingDirectory, diagnostic.filePath)}${
          diagnostic.line === null
            ? ''
            : `:${String(diagnostic.line)}:${String(diagnostic.column ?? 1)}`
        } - `;

  return `${location}${diagnostic.category} TS${String(diagnostic.code)}: ${diagnostic.message}`;
}

/**
 * Render one entry of a failure's `diagnostics` for a human: a durability lint diagnostic (it has
 * `rule`) as `path:line:col - <category> QCnnn: message`, a compiler diagnostic as before.
 */
export function formatWorkflowDiagnostic(
  diagnostic: TypecheckDiagnosticDetails | DurabilityDiagnostic,
  workingDirectory: string,
): string {
  return 'rule' in diagnostic
    ? formatDurabilityDiagnostic(diagnostic, workingDirectory)
    : formatTypecheckDiagnostic(diagnostic, workingDirectory);
}

/** One `Next: <shell-quoted argv>  (why)` line per runnable follow-up. @internal */
export function formatNextCommands(next: readonly NextCommand[] | undefined): string[] {
  return (next ?? []).map((entry) => `Next: ${formatArgv(entry.argv)}  (${entry.why})`);
}
