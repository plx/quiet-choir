import { dirname, extname, resolve } from 'node:path';

import ts from 'typescript';

import {
  TYPESCRIPT_DECLARATION_EXTENSIONS,
  TYPESCRIPT_SOURCE_EXTENSIONS,
  type TypecheckPlanAnalysis,
} from './model.js';

/** Analyze a user-supplied entrypoint and produce a serializable typecheck plan. */
export function analyzeTypecheckEntrypoint(
  inputPath: string,
  workingDirectory: string,
): TypecheckPlanAnalysis {
  const entrypoint = resolve(workingDirectory, inputPath);
  const lowerCaseEntrypoint = entrypoint.toLowerCase();
  const extension = extname(entrypoint).toLowerCase();

  if (
    TYPESCRIPT_DECLARATION_EXTENSIONS.some((candidate) => lowerCaseEntrypoint.endsWith(candidate))
  ) {
    return {
      error: {
        code: 'DECLARATION_TYPESCRIPT_ENTRYPOINT',
        message: `A TypeScript declaration file cannot be a workflow entrypoint: ${inputPath}`,
      },
      ok: false,
    };
  }

  if (!TYPESCRIPT_SOURCE_EXTENSIONS.some((candidate) => candidate === extension)) {
    return {
      error: {
        code: 'UNSUPPORTED_TYPESCRIPT_EXTENSION',
        message: `Expected a TypeScript source file (${TYPESCRIPT_SOURCE_EXTENSIONS.join(', ')}) but received: ${inputPath}`,
      },
      ok: false,
    };
  }

  const configPath = ts.findConfigFile(
    dirname(entrypoint),
    (filePath) => ts.sys.fileExists(filePath),
    'tsconfig.json',
  );

  return {
    ok: true,
    plan: {
      configuration:
        configPath === undefined
          ? { kind: 'defaults', profile: 'node22-es2023-strict' }
          : { kind: 'tsconfig', path: configPath },
      entrypoint,
      kind: 'workflow.typecheck',
    },
  };
}
