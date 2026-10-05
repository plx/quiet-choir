import { createHash } from 'node:crypto';

import ts from 'typescript';

import { jsonValue } from '../runtime/json.js';
import type { JsonValue } from '../runtime/model.js';

/** Option sets a {@link TypecheckProgramCache} keeps before evicting the least recently used one. */
const defaultMaxOptionSets = 8;

/**
 * Compiler options as sorted plain data with enum values named, without the parsed config file.
 * Results report it, and {@link TypecheckProgramCache} keys its option sets by it. @internal
 */
export function normalizedCompilerOptions(
  options: ts.CompilerOptions,
): Readonly<Record<string, JsonValue>> {
  const enums: Record<string, Readonly<Record<number, string>>> = {
    target: ts.ScriptTarget,
    module: ts.ModuleKind,
    moduleResolution: ts.ModuleResolutionKind,
    jsx: ts.JsxEmit,
    newLine: ts.NewLineKind,
    moduleDetection: ts.ModuleDetectionKind,
  };
  return Object.fromEntries(
    Object.entries(options)
      .filter(
        ([key, value]) => key !== 'configFile' && key !== 'configFilePath' && value !== undefined,
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        typeof value === 'number' && enums[key]?.[value] !== undefined
          ? enums[key][value]
          : jsonValue(value),
      ]),
  );
}

/** Root files, options and config diagnostics of one type-check program. @internal */
export interface TypecheckProgramRequest {
  readonly rootNames: readonly string[];
  readonly options: ts.CompilerOptions;
  readonly projectReferences?: readonly ts.ProjectReference[];
  readonly configFileParsingDiagnostics?: readonly ts.Diagnostic[];
}

/** A freshly built program and its pre-emit diagnostics. @internal */
export interface TypecheckProgram {
  readonly program: ts.Program;
  /**
   * The diagnostics `ts.getPreEmitDiagnostics(program)` reports, in the same order. The first call
   * records this program as the base the option set's next check compares against.
   */
  readonly diagnostics: () => readonly ts.Diagnostic[];
}

/** Parsed files and the last builder program of one compiler-option set. */
interface OptionSet {
  readonly sourceFiles: Map<string, ts.SourceFile>;
  builder?: ts.SemanticDiagnosticsBuilderProgram;
}

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Shares parsing and semantic checking between type checks of workflows that import the same files,
 * such as test suites that each import the whole engine source. @internal
 *
 * Each check builds a new program with fresh module resolution and no `oldProgram`, so added,
 * removed or moved files and changed package.json or tsconfig files are always seen. Per
 * compiler-option set (keyed by {@link normalizedCompilerOptions}) the cache keeps:
 *
 * - parsed source files, reused only when the file name, language version, implied module format,
 *   JSDoc parsing mode and a SHA-256 of the file text all match; and
 * - the previous `SemanticDiagnosticsBuilderProgram`, from which TypeScript's builder (the `tsc
 *   --watch` model) copies semantic diagnostics only for files whose text and references are
 *   unchanged and that no changed file affects. The builder is not used, and every file is checked
 *   again, if any file both programs share resolves an import or type reference differently, or if
 *   an added, removed or changed file affects the global scope in its old or new version (a script,
 *   or a module with a `declare global` block).
 *   Every file is also checked again if a copied diagnostic still points into a source file that
 *   was parsed again.
 *
 * After each check the parsed files are pruned to those of the new program, and at most
 * `maxOptionSets` option sets are kept, evicting the least recently used. Nothing is persisted.
 * Production commands create none, so a fresh cache per check matches `ts.getPreEmitDiagnostics`.
 */
export class TypecheckProgramCache {
  readonly #optionSets = new Map<string, OptionSet>();
  readonly #maxOptionSets: number;

  public constructor(maxOptionSets = defaultMaxOptionSets) {
    this.#maxOptionSets = maxOptionSets;
  }

  /** Build the program for a request and its diagnostics, reusing unchanged work. */
  public check(request: TypecheckProgramRequest): TypecheckProgram {
    const optionSet = this.#optionSet(request.options);
    const host = ts.createIncrementalCompilerHost(request.options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      // Without an oldProgram, createProgram never asks for a new copy of a file it already has.
      const text = host.readFile(fileName);
      if (text === undefined)
        return getSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        );
      const key = (sourceText: string) =>
        sourceFileKey(fileName, languageVersionOrOptions, sourceText);
      const cached = optionSet.sourceFiles.get(key(text));
      if (cached !== undefined) return cached;
      const parsed = getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
      if (parsed !== undefined) optionSet.sourceFiles.set(key(parsed.text), parsed);
      return parsed;
    };
    const program = ts.createProgram({
      host,
      options: request.options,
      rootNames: request.rootNames,
      ...(request.projectReferences === undefined
        ? {}
        : { projectReferences: request.projectReferences }),
      ...(request.configFileParsingDiagnostics === undefined
        ? {}
        : { configFileParsingDiagnostics: request.configFileParsingDiagnostics }),
    });
    const current = new Set(program.getSourceFiles());
    for (const [key, sourceFile] of optionSet.sourceFiles)
      if (!current.has(sourceFile)) optionSet.sourceFiles.delete(key);

    return {
      program,
      diagnostics: () => {
        // The builder diffs file versions against whichever builder this option set kept last. It
        // does not compare module resolutions or see that a replaced file affected the global scope
        // before, so either makes this a full check.
        const previous = optionSet.builder;
        const builder = ts.createSemanticDiagnosticsBuilderProgram(
          program,
          host,
          previous !== undefined && canReuseBuilder(previous.getProgram(), program)
            ? previous
            : undefined,
          request.configFileParsingDiagnostics,
        );
        optionSet.builder = builder;
        return preEmitDiagnostics(program, builder);
      },
    };
  }

  #optionSet(options: ts.CompilerOptions): OptionSet {
    const key = JSON.stringify(normalizedCompilerOptions(options));
    const optionSet = this.#optionSets.get(key) ?? { sourceFiles: new Map() };
    this.#optionSets.delete(key);
    this.#optionSets.set(key, optionSet);
    for (const oldest of this.#optionSets.keys()) {
      if (this.#optionSets.size <= this.#maxOptionSets) break;
      this.#optionSets.delete(oldest);
    }
    return optionSet;
  }
}

function sourceFileKey(
  fileName: string,
  languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
  text: string,
): string {
  const options =
    typeof languageVersionOrOptions === 'object'
      ? languageVersionOrOptions
      : { languageVersion: languageVersionOrOptions };
  return JSON.stringify([
    fileName,
    options.languageVersion,
    options.impliedNodeFormat ?? null,
    options.jsDocParsingMode ?? null,
    textHash(text),
  ]);
}

/**
 * TypeScript 6 `Program` methods that list every file's module and type reference resolutions. They
 * are not in the public declarations, so {@link sameResolutions} checks they exist.
 */
interface ResolutionListing {
  readonly forEachResolvedModule?: (
    callback: (
      resolution: ts.ResolvedModuleWithFailedLookupLocations,
      name: string,
      mode: ts.ResolutionMode,
      filePath: string,
    ) => void,
  ) => void;
  readonly forEachResolvedTypeReferenceDirective?: (
    callback: (
      resolution: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
      name: string,
      mode: ts.ResolutionMode,
      filePath: string,
    ) => void,
  ) => void;
}

/** A resolved package's identity as fingerprint parts. */
function packageIdParts(packageId: ts.PackageId | undefined): readonly (string | null)[] {
  return [packageId?.name ?? null, packageId?.subModuleName ?? null, packageId?.version ?? null];
}

/**
 * Each file's module and type reference resolutions as one string, or undefined if unlisted. An
 * entry holds the resolved file and the metadata that decides which diagnostics it yields, such as
 * the extension, whether a TypeScript extension was written, and the package it came from.
 */
function resolutionFingerprints(program: ts.Program): ReadonlyMap<string, string> | undefined {
  const listing = program as ts.Program & ResolutionListing;
  if (
    typeof listing.forEachResolvedModule !== 'function' ||
    typeof listing.forEachResolvedTypeReferenceDirective !== 'function'
  )
    return undefined;
  const resolutions = new Map<string, string[]>();
  const add = (filePath: string, entry: readonly (string | number | boolean | null)[]) => {
    const entries = resolutions.get(filePath) ?? [];
    entries.push(JSON.stringify(entry));
    resolutions.set(filePath, entries);
  };
  listing.forEachResolvedModule((resolution, name, mode, filePath) => {
    const resolved = resolution.resolvedModule;
    add(filePath, [
      'module',
      name,
      mode ?? null,
      resolved?.resolvedFileName ?? null,
      resolved?.extension ?? null,
      resolved?.resolvedUsingTsExtension ?? null,
      resolved?.isExternalLibraryImport ?? null,
      ...packageIdParts(resolved?.packageId),
    ]);
  });
  listing.forEachResolvedTypeReferenceDirective((resolution, name, mode, filePath) => {
    const resolved = resolution.resolvedTypeReferenceDirective;
    add(filePath, [
      'types',
      name,
      mode ?? null,
      resolved?.resolvedFileName ?? null,
      resolved?.primary ?? null,
      resolved?.isExternalLibraryImport ?? null,
      ...packageIdParts(resolved?.packageId),
    ]);
  });
  return new Map(
    [...resolutions].map(([filePath, entries]) => [filePath, entries.sort().join('\n')]),
  );
}

/**
 * Whether every file both programs list resolves its imports and type references to the same target
 * with the same resolution metadata as before. A file only one of them lists was added, removed or
 * edited, which the builder already sees. When the resolutions cannot be listed this answers false,
 * so the caller checks every file.
 */
function sameResolutions(previous: ts.Program, next: ts.Program): boolean {
  const before = resolutionFingerprints(previous);
  const after = resolutionFingerprints(next);
  if (before === undefined || after === undefined) return false;
  for (const [filePath, fingerprint] of after) {
    const old = before.get(filePath);
    if (old !== undefined && old !== fingerprint) return false;
  }
  return true;
}

/** Whether a module declaration is a `declare global` block. */
function isGlobalAugmentation(statement: ts.Statement): boolean {
  return (
    ts.isModuleDeclaration(statement) && (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0
  );
}

/**
 * Whether a file declares into the global scope: a script, or a module with a `declare global`
 * block at its top level or in an ambient module declaration. JSON files never do.
 */
function affectsGlobalScope(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.fileName.endsWith('.json')) return false;
  if (!ts.isExternalModule(sourceFile)) return true;
  return sourceFile.statements.some(
    (statement) =>
      isGlobalAugmentation(statement) ||
      (ts.isModuleDeclaration(statement) &&
        statement.body !== undefined &&
        ts.isModuleBlock(statement.body) &&
        statement.body.statements.some(isGlobalAugmentation)),
  );
}

/**
 * Whether a file that only one program has, or that the programs parsed differently, affects the
 * global scope in either version. The builder decides from the new version alone, so a file that
 * stops declaring globals would leave the results of files that used them stale.
 */
function replacedGlobalScope(previous: ts.Program, next: ts.Program): boolean {
  const before = new Map(previous.getSourceFiles().map((file) => [file.fileName, file]));
  for (const file of next.getSourceFiles()) {
    const old = before.get(file.fileName);
    before.delete(file.fileName);
    if (old === file) continue;
    if (affectsGlobalScope(file) || (old !== undefined && affectsGlobalScope(old))) return true;
  }
  return [...before.values()].some(affectsGlobalScope);
}

/**
 * Whether the builder may copy results from the previous program: resolutions are unchanged, and no
 * replaced file affects the global scope.
 */
function canReuseBuilder(previous: ts.Program, next: ts.Program): boolean {
  return sameResolutions(previous, next) && !replacedGlobalScope(previous, next);
}

/** Whether a diagnostic or its related information points into a file the program replaced. */
function pointsIntoReplacedFile(program: ts.Program, diagnostic: ts.Diagnostic): boolean {
  return [diagnostic, ...(diagnostic.relatedInformation ?? [])].some(
    (item) => item.file !== undefined && program.getSourceFile(item.file.fileName) !== item.file,
  );
}

/**
 * Semantic diagnostics from the builder. The builder copies a file's diagnostics when the file and
 * the declaration signatures it depends on are unchanged, so a copied diagnostic can still point
 * into the previous parse of a file that changed only in its body or layout, with stale positions.
 * Then the new program checks everything again.
 */
function semanticDiagnostics(
  program: ts.Program,
  builder: ts.SemanticDiagnosticsBuilderProgram,
): readonly ts.Diagnostic[] {
  const diagnostics = builder.getSemanticDiagnostics();
  return diagnostics.some((diagnostic) => pointsIntoReplacedFile(program, diagnostic))
    ? program.getSemanticDiagnostics()
    : diagnostics;
}

/** `ts.getPreEmitDiagnostics`, taking semantic diagnostics from the builder. */
function preEmitDiagnostics(
  program: ts.Program,
  builder: ts.SemanticDiagnosticsBuilderProgram,
): readonly ts.Diagnostic[] {
  const options = program.getCompilerOptions();
  return ts.sortAndDeduplicateDiagnostics([
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...semanticDiagnostics(program, builder),
    ...(options.declaration === true || options.composite === true
      ? program.getDeclarationDiagnostics()
      : []),
  ]);
}
