import { relative } from 'node:path';

import type { JsonValue } from '../runtime/model.js';

import type { ExecutionPlan, ExecutionResult } from '../../application/execution.js';

/** Supported TypeScript workflow source suffixes. */
export const TYPESCRIPT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

/** TypeScript declaration suffixes, which are not executable workflow entrypoints. */
export const TYPESCRIPT_DECLARATION_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts'] as const;

/** How the TypeScript compiler should be configured for a plan. */
export type TypecheckConfiguration =
  | {
      readonly kind: 'tsconfig';
      readonly path: string;
    }
  | {
      readonly kind: 'defaults';
      readonly profile: 'node22-es2023-strict';
    };

/** Plain-data plan for type-checking a workflow entrypoint. */
export interface TypecheckPlan extends ExecutionPlan {
  readonly configuration: TypecheckConfiguration;
  readonly entrypoint: string;
  readonly kind: 'workflow.typecheck';
}

/** JSON-safe diagnostic category. */
export type TypecheckDiagnosticCategory = 'error' | 'warning' | 'suggestion' | 'message';

/** Common fields for a compiler diagnostic normalized into plain data. */
export interface TypecheckDiagnosticDetails {
  readonly category: TypecheckDiagnosticCategory;
  readonly code: number;
  readonly column: number | null;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly message: string;
}

/** A compiler diagnostic, including JSON-safe secondary locations. */
export interface TypecheckDiagnostic extends TypecheckDiagnosticDetails {
  readonly relatedInformation: readonly TypecheckDiagnosticDetails[];
}

/**
 * Rule codes of the static durability lint that `workflow validate` and execution run after a
 * clean type check (ADR 0041): QC001 discarded effect promise, QC002 nondeterministic read in the
 * workflow body, QC003 durable call inside a step or poll callback, QC004 `Promise.race`/`any`
 * over durable calls, QC005 literal effect ID reused or repeated in a loop. QC006 (the removed
 * positional `ctx.map`) is retired and its code is never reused.
 */
export const DURABILITY_RULES = ['QC001', 'QC002', 'QC003', 'QC004', 'QC005'] as const;

/** One durability lint rule code. */
export type DurabilityRule = (typeof DURABILITY_RULES)[number];

/** A durability lint finding: plain data with a 1-based source position. */
export interface DurabilityFinding {
  /** Rule code. */
  readonly rule: DurabilityRule;
  /** Absolute path of the workflow source file. */
  readonly file: string;
  /** 1-based line of the finding's node. */
  readonly line: number;
  /** 1-based column of the finding's node. */
  readonly column: number;
  /** What the code does and what to use instead. */
  readonly message: string;
}

/**
 * A durability finding as reported by a command: an `error` that fails `workflow validate`, or a
 * `warning` that execution logs and continues past. It shares a failure's `diagnostics` array with
 * compiler diagnostics and is told apart by `rule` (compiler entries carry `code` and `filePath`).
 */
export interface DurabilityDiagnostic extends DurabilityFinding {
  /** `error` from `workflow validate`; `warning` where the lint does not block. */
  readonly category: 'error' | 'warning';
}

/** Render a durability diagnostic for a human as `path:line:col - <category> QCnnn: message`. */
export function formatDurabilityDiagnostic(
  diagnostic: DurabilityDiagnostic,
  workingDirectory: string,
): string {
  return `${relative(workingDirectory, diagnostic.file)}:${String(diagnostic.line)}:${String(
    diagnostic.column,
  )} - ${diagnostic.category} ${diagnostic.rule}: ${diagnostic.message}`;
}

/** Plain-data result of type-checking a workflow. */
export interface TypecheckResult extends ExecutionResult {
  readonly compilerVersion: string;
  /** Effective compiler options, with named enum values and no live compiler objects. */
  readonly compilerOptions: Readonly<Record<string, JsonValue>>;
  readonly configPath: string | null;
  readonly diagnostics: readonly TypecheckDiagnostic[];
  readonly entrypoint: string;
  readonly kind: 'workflow.typecheck.result';
  readonly ok: boolean;
  /** Local source dependencies discovered by the compiler, including declarations. */
  readonly sourceFiles: readonly string[];
  /**
   * Durability lint findings, present only when the executor was built with `durabilityLint` and
   * the type check reported no errors.
   */
  readonly durability?: readonly DurabilityFinding[];
}

/** Result of analyzing an entrypoint before execution. */
export type TypecheckPlanAnalysis =
  | {
      readonly ok: true;
      readonly plan: TypecheckPlan;
    }
  | {
      readonly error: {
        readonly code: 'DECLARATION_TYPESCRIPT_ENTRYPOINT' | 'UNSUPPORTED_TYPESCRIPT_EXTENSION';
        readonly message: string;
      };
      readonly ok: false;
    };
