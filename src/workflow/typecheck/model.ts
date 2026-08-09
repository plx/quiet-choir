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

/** Plain-data result of type-checking a workflow. */
export interface TypecheckResult extends ExecutionResult {
  readonly compilerVersion: string;
  readonly configPath: string | null;
  readonly diagnostics: readonly TypecheckDiagnostic[];
  readonly entrypoint: string;
  readonly kind: 'workflow.typecheck.result';
  readonly ok: boolean;
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
