import type { HarnessCapabilities } from './harness-model.js';
import type { HarnessDeclaration } from './harness-model.js';
import type { z } from 'zod';
import type { JsonValue } from './model.js';
import type { AgentDefaults, AgentProfile, CapabilityManifest } from './profiles-model.js';

/** A child declaration with erased input/output types; typed calls use WorkflowDefinition directly. */
export interface WorkflowDeclaration {
  /** Explicit typed agent registrations available in this child. */
  readonly harnesses?: readonly HarnessDeclaration[];
  /** Stable dispatch name. */
  readonly name: string;
  /** Explicit compatibility version. */
  readonly version: string;
  /** Input schema, validated before entering the child. */
  readonly input: z.ZodType;
  /** Output schema, validated before returning to the parent. */
  readonly output: z.ZodType;
  /** Callable body; the never input makes typed definitions assignable without permitting unchecked calls. */
  readonly run: (context: never, input: never) => Promise<unknown>;
  /** Human purpose, outside replay identity. */
  readonly description?: string;
  /** Selection guidance, outside replay identity. */
  readonly whenToUse?: string;
  /** Expected stages, outside replay identity. */
  readonly phases?: readonly WorkflowPhase[];
  /** Children available to name-based inline dispatch. */
  readonly children?: readonly WorkflowDeclaration[];
  /** Named capability requirements. */
  readonly profiles?: Readonly<Record<string, AgentProfile>>;
  /** Implicit role and common agent settings. */
  readonly defaults?: AgentDefaults;
  /** Call-site capability policy. */
  readonly strictProfiles?: boolean;
}

/** An optional descriptive stage, not a durable effect or progress event. */
export interface WorkflowPhase {
  /** Human stage label. */
  readonly title: string;
  /** Optional explanation. */
  readonly detail?: string;
}

/** Capability delegation for an inline child in its parent's run. */
export interface ChildOptions {
  /** Child role to parent role; omitted roles use the same name. Delegation never expands capabilities. */
  readonly profiles?: Readonly<Record<string, string>>;
}

/** Persisted inline invocation; the workflow body replays, while named effects retain their outcomes. */
export interface ChildRecord {
  /** Whether the parent declares this child, allowing identity checks when a settled mapper is skipped. */
  readonly declared: boolean;
  /** The caller's local frame label, retained even when a long path is compacted. */
  readonly label: string;
  /** Child identity, independent of descriptive metadata. */
  readonly workflow: {
    /** Stable child name. */
    readonly name: string;
    /** Explicit child compatibility version. */
    readonly version: string;
  };
  /** Parent frame ID, or null for a child of the root workflow. */
  readonly parent: string | null;
  /** First child depth is one; the root is zero. */
  readonly depth: number;
  /** Digest of the normalized, schema-validated input. */
  readonly inputDigest: string;
  /** Input/output schema identity; descriptions of the workflow itself are excluded. */
  readonly schemaDigest: string;
  /** Last recorded frame state. Suspension applies to the enclosing run. */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'suspended';
  /** Start time of the latest body execution. */
  startedAt: string;
  /** Latest durable settlement time, or null for an active/parked frame. */
  finishedAt: string | null;
  /** Latest body/validation failure, or null. */
  error: string | null;
}

/** JSON-safe workflow discovery data, obtained without calling the workflow body. */
export interface WorkflowDescription {
  /** Explicit and implicit harness contracts, listed without constructing adapters. */
  readonly harnesses: readonly {
    /** Persisted registration name. */
    readonly name: string;
    /** Semantic option revision. */
    readonly revision: number;
    /** Strict registered option schema. */
    readonly options: JsonValue;
    /** Declared structured response and tool support. */
    readonly capabilities: HarnessCapabilities;
    /** Whether the package provides an adapter factory. */
    readonly factory: boolean;
    /** Whether a zero-inference installation probe is available. */
    readonly probe: boolean;
  }[];
  /** Stable name. */
  readonly name: string;
  /** Compatibility version. */
  readonly version: string;
  /** Optional human purpose. */
  readonly description: string | null;
  /** Optional selection guidance. */
  readonly whenToUse: string | null;
  /** Descriptive stages, in order. */
  readonly phases: readonly WorkflowPhase[];
  /** Published input JSON Schema, including required fields and field descriptions. */
  readonly inputSchema: JsonValue;
  /** Published output JSON Schema. */
  readonly outputSchema: JsonValue;
  /** Resolved roles with private environment values removed. */
  readonly capabilities: CapabilityManifest;
  /** Declared profile names, separate from implicit built-ins. */
  readonly profiles: Readonly<Record<string, CapabilityManifest['defaults']>>;
  /** Declared child tree. A recursive reference has an empty children array. */
  readonly children: readonly WorkflowDescription[];
  /** A repeated ancestor in a recursive declaration; recursion is permitted at runtime. */
  readonly recursive: boolean;
  /** Trusted source path when known; inline definitions need not have separate entrypoints. */
  readonly entrypoint: string | null;
}
