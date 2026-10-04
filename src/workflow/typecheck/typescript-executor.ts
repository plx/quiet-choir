import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import type { JsonValue } from '../runtime/model.js';

import type { ExecutionLogger, Executor } from '../../application/execution.js';
import { lintDurability } from './durability-lint.js';
import {
  normalizedCompilerOptions,
  TypecheckProgramCache,
  type TypecheckProgram,
} from './program-cache.js';
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

interface CompilerAnalysis {
  readonly compilerOptions: Readonly<Record<string, JsonValue>>;
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly program?: ts.Program;
  readonly sourceFiles: readonly string[];
}

function analyzeProgram({ program, diagnostics }: TypecheckProgram): CompilerAnalysis {
  return {
    program,
    compilerOptions: normalizedCompilerOptions(program.getCompilerOptions()),
    diagnostics: diagnostics(),
    sourceFiles: program
      .getSourceFiles()
      .map((file) => resolve(file.fileName))
      .filter((file) => !file.split(sep).includes('node_modules'))
      .sort(),
  };
}

/**
 * Build the type-check program for root files under a tsconfig: the config's compiler options and
 * declaration files, with `rootNames` replacing its `files`/`include`. Returns the config read
 * error instead when the file cannot be read. A shared `cache` reuses unchanged files' parsing and
 * semantic checking from earlier calls; without one the program is built from scratch. @internal
 */
export function configuredProgram(
  rootNames: readonly string[],
  configPath: string,
  cache: TypecheckProgramCache = new TypecheckProgramCache(),
): TypecheckProgram | { readonly error: ts.Diagnostic } {
  const configDirectory = dirname(configPath);
  const readResult = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));

  if (readResult.error !== undefined) return { error: readResult.error };

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
    files: rootNames.map((rootName) => relative(configDirectory, rootName)),
    include: [],
  };
  const parsedConfig = ts.parseJsonConfigFileContent(
    entrypointConfig,
    ts.sys,
    configDirectory,
    undefined,
    configPath,
  );
  const programRoots = [
    ...new Set([
      ...parsedConfig.fileNames,
      ...discoveredConfig.fileNames.filter((filePath) => isDeclarationFile(filePath)),
    ]),
  ];
  return cache.check({
    configFileParsingDiagnostics: parsedConfig.errors,
    options: {
      ...parsedConfig.options,
      noCheck: false,
      noEmit: true,
    },
    ...(parsedConfig.projectReferences === undefined
      ? {}
      : { projectReferences: parsedConfig.projectReferences }),
    rootNames: programRoots,
  });
}

function configuredDiagnostics(
  entrypoint: string,
  configPath: string,
  cache: TypecheckProgramCache,
): CompilerAnalysis {
  const configured = configuredProgram([entrypoint], configPath, cache);
  if ('error' in configured)
    return { compilerOptions: {}, diagnostics: [configured.error], sourceFiles: [] };
  return analyzeProgram(configured);
}

function defaultDiagnostics(plan: TypecheckPlan, cache: TypecheckProgramCache): CompilerAnalysis {
  const checked = cache.check({
    options: {
      allowImportingTsExtensions: true,
      forceConsistentCasingInFileNames: true,
      jsx: ts.JsxEmit.Preserve,
      lib: ['lib.es2023.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noCheck: false,
      noEmit: true,
      noUncheckedIndexedAccess: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      typeRoots: [bundledNodeTypesRoot],
      types: ['node'],
    },
    rootNames: [plan.entrypoint],
  });

  return analyzeProgram(checked);
}

/** Options of a {@link TypeScriptExecutor}. */
export interface TypeScriptExecutorOptions {
  /**
   * Run the durability lint (ADR 0041) on the same program after a type check without errors and
   * return its findings as `durability`. Off by default, so `workflow typecheck` and doctor keep
   * their output.
   */
  readonly durabilityLint?: boolean;
  /**
   * Internal: share parsing and semantic checking with other executors that pass the same cache.
   * Tests use it to avoid repeating whole-engine compiles; without it each check starts from
   * scratch. @internal
   */
  readonly cache?: TypecheckProgramCache | undefined;
}

/** Type-checks workflow plans with the packaged stable TypeScript compiler API. */
export class TypeScriptExecutor implements Executor<TypecheckPlan, TypecheckResult> {
  readonly #logger: ExecutionLogger;
  readonly #durabilityLint: boolean;
  readonly #cache: TypecheckProgramCache | undefined;

  public constructor(logger: ExecutionLogger, options: TypeScriptExecutorOptions = {}) {
    this.#logger = logger;
    this.#durabilityLint = options.durabilityLint === true;
    this.#cache = options.cache;
  }

  public execute(plan: TypecheckPlan): Promise<TypecheckResult> {
    this.#logger.log('trace', `Type-checking ${plan.entrypoint}`);
    this.#logger.log(
      'debug',
      plan.configuration.kind === 'tsconfig'
        ? `Using ${plan.configuration.path}`
        : `Using ${plan.configuration.profile}`,
    );

    const cache = this.#cache ?? new TypecheckProgramCache();
    const analysis =
      plan.configuration.kind === 'tsconfig'
        ? configuredDiagnostics(plan.entrypoint, plan.configuration.path, cache)
        : defaultDiagnostics(plan, cache);
    const diagnostics = analysis.diagnostics.map(normalizeDiagnostic);
    const ok = !diagnostics.some((diagnostic) => diagnostic.category === 'error');
    const durability =
      ok && this.#durabilityLint && analysis.program
        ? lintDurability(analysis.program).map((finding) => ({
            ...finding,
            file: resolve(finding.file),
          }))
        : undefined;

    return Promise.resolve({
      compilerVersion: ts.version,
      compilerOptions: analysis.compilerOptions,
      configPath: plan.configuration.kind === 'tsconfig' ? plan.configuration.path : null,
      diagnostics,
      entrypoint: plan.entrypoint,
      kind: 'workflow.typecheck.result',
      ok,
      sourceFiles: analysis.sourceFiles,
      ...(durability === undefined ? {} : { durability }),
    });
  }
}
