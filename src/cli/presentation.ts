import { relative } from 'node:path';

import type { StubResult } from '../application/stub.js';
import type { TypecheckDiagnosticDetails } from '../workflow/typecheck/model.js';

/** Render a placeholder execution result for a human. */
export function formatStubResult(result: StubResult): string {
  return `${result.command.replace('.', ' ')} is not implemented yet.`;
}

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
