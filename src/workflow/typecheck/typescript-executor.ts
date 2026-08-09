import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

import type { ExecutionLogger, Executor } from '../../application/execution.js';
import type {
  TypecheckDiagnostic,
  TypecheckDiagnosticCategory,
  TypecheckDiagnosticDetails,
  TypecheckPlan,
  TypecheckResult,
} from './model.js';

const require = createRequire(import.meta.url);
const bundledNodeTypesRoot = dirname(dirname(require.resolve('@types/node/package.json')));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnosticCategory(category: ts.DiagnosticCategory): TypecheckDiagnosticCategory {
  switch (category) {
    case ts.DiagnosticCategory.Error: {
      return 'error';
    }

    case ts.DiagnosticCategory.Warning: {
      return 'warning';
    }

    case ts.DiagnosticCategory.Suggestion: {
      return 'suggestion';
    }

    case ts.DiagnosticCategory.Message: {
      return 'message';
    }
  }
}

function normalizeDiagnosticDetails(
  diagnostic: ts.DiagnosticRelatedInformation,
): TypecheckDiagnosticDetails {
  const location =
    diagnostic.file === undefined || diagnostic.start === undefined
      ? undefined
      : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

  return {
    category: diagnosticCategory(diagnostic.category),
    code: diagnostic.code,
    column: location === undefined ? null : location.character + 1,
    filePath: diagnostic.file === undefined ? null : resolve(diagnostic.file.fileName),
    line: location === undefined ? null : location.line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
}

function normalizeDiagnostic(diagnostic: ts.Diagnostic): TypecheckDiagnostic {
  return {
    ...normalizeDiagnosticDetails(diagnostic),
    relatedInformation: (diagnostic.relatedInformation ?? []).map(normalizeDiagnosticDetails),
  };
}

function isDeclarationFile(filePath: string): boolean {
  const lowerCaseFilePath = filePath.toLowerCase();

  return (
    lowerCaseFilePath.endsWith('.d.ts') ||
    lowerCaseFilePath.endsWith('.d.mts') ||
    lowerCaseFilePath.endsWith('.d.cts')
  );
}

function configuredDiagnostics(entrypoint: string, configPath: string): readonly ts.Diagnostic[] {
  const configDirectory = dirname(configPath);
  const readResult = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));

  if (readResult.error !== undefined) {
    return [readResult.error];
  }

  const rawConfig = isRecord(readResult.config) ? readResult.config : {};
  const discoveredConfig = ts.parseJsonConfigFileContent(
    rawConfig,
    ts.sys,
    configDirectory,
    undefined,
    configPath,
  );
  const entrypointConfig: Record<string, unknown> = {
    ...rawConfig,
    exclude: [],
    files: [relative(configDirectory, entrypoint)],
    include: [],
  };
  const parsedConfig = ts.parseJsonConfigFileContent(
    entrypointConfig,
    ts.sys,
    configDirectory,
    undefined,
    configPath,
  );
  const rootNames = [
    ...new Set([
      ...parsedConfig.fileNames,
      ...discoveredConfig.fileNames.filter((filePath) => isDeclarationFile(filePath)),
    ]),
  ];
  const program = ts.createProgram({
    configFileParsingDiagnostics: parsedConfig.errors,
    options: {
      ...parsedConfig.options,
      noCheck: false,
      noEmit: true,
    },
    ...(parsedConfig.projectReferences === undefined
      ? {}
      : { projectReferences: parsedConfig.projectReferences }),
    rootNames,
  });

  return ts.getPreEmitDiagnostics(program);
}

function defaultDiagnostics(plan: TypecheckPlan): readonly ts.Diagnostic[] {
  const program = ts.createProgram({
    options: {
      allowImportingTsExtensions: true,
      forceConsistentCasingInFileNames: true,
      jsx: ts.JsxEmit.Preserve,
      lib: ['lib.es2023.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noCheck: false,
      noEmit: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      typeRoots: [bundledNodeTypesRoot],
      types: ['node'],
    },
    rootNames: [plan.entrypoint],
  });

  return ts.getPreEmitDiagnostics(program);
}

/** Type-checks workflow plans with the packaged stable TypeScript compiler API. */
export class TypeScriptExecutor implements Executor<TypecheckPlan, TypecheckResult> {
  readonly #logger: ExecutionLogger;

  public constructor(logger: ExecutionLogger) {
    this.#logger = logger;
  }

  public execute(plan: TypecheckPlan): Promise<TypecheckResult> {
    this.#logger.log('trace', `Type-checking ${plan.entrypoint}`);
    this.#logger.log(
      'debug',
      plan.configuration.kind === 'tsconfig'
        ? `Using ${plan.configuration.path}`
        : `Using ${plan.configuration.profile}`,
    );

    const diagnostics = (
      plan.configuration.kind === 'tsconfig'
        ? configuredDiagnostics(plan.entrypoint, plan.configuration.path)
        : defaultDiagnostics(plan)
    ).map(normalizeDiagnostic);

    return Promise.resolve({
      compilerVersion: ts.version,
      configPath: plan.configuration.kind === 'tsconfig' ? plan.configuration.path : null,
      diagnostics,
      entrypoint: plan.entrypoint,
      kind: 'workflow.typecheck.result',
      ok: !diagnostics.some((diagnostic) => diagnostic.category === 'error'),
    });
  }
}
