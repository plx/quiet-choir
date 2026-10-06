import type { HarnessCapabilities } from './harness-model.js';
import type { HarnessDeclaration } from './harness-model.js';
import type { z } from 'zod';
import type { ErrorMode, JsonValue, Settled } from './model.js';
import type { MapStepError } from './fan-out.js';
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
  /**
   * Throw a child failure by default, or save the frame's outcome and return it as
   * `Settled<O, MapStepError>`. A settled frame is terminal: resume returns the saved outcome without
   * running the body again. Its descendants must be declared. Cancellation, budget stops,
   * configuration, checkpoint and authoring failures still reject, as do input, depth and identity
   * errors raised before the frame starts.
   */
  readonly onError?: ErrorMode | undefined;
}

/** The saved terminal outcome of an `onError: 'return'` child frame. */
export interface ChildSettledRecord {
  /** The child's validated output, or the failure attributed to its originating effect. */
  readonly outcome: Settled<JsonValue, MapStepError>;
  /** Leaf effect IDs the frame owned, claimed without running them again on replay. */
  readonly steps: readonly string[];
  /** Settled map journal IDs the frame owned. */
  readonly maps: readonly string[];
  /** Descendant child frame IDs the frame owned. */
  readonly children: readonly string[];
}

/** A prior identity of an unfinished child frame, replaced when a resume invoked it under a new one. */
export interface ChildRedefinition {
  /** The replaced child name and compatibility version. */
  readonly workflow: {
    /** Prior child name. */
    readonly name: string;
    /** Prior child compatibility version. */
    readonly version: string;
  };
  /** Prior input/output schema identity. */
  readonly schemaDigest: string;
  /** Prior digest of the normalized, schema-validated input. */
  readonly inputDigest: string;
  /** When the resume replaced this identity. */
  readonly redefinedAt: string;
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
  /**
   * Present only for a frame invoked with `onError: 'return'`; frames in the default throw mode omit
   * it, so their records keep their earlier shape.
   */
  onError?: 'return';
  /**
   * The committed outcome of an `onError: 'return'` frame. Its presence makes the frame terminal:
   * resume replays the outcome and claims the owned IDs without running the body.
   */
  settled?: ChildSettledRecord;
  /**
   * Prior identities of this frame, oldest first. A failed, cancelled or superseded frame that owns
   * no completed or settled work may be invoked under a changed name, version, input or schemas;
   * the identity it replaced is appended here. Absent until the first redefinition.
   */
  redefinitions?: ChildRedefinition[];
  /**
   * Last recorded frame state. Suspension applies to the enclosing run. `superseded` is terminal
   * until a later execution invokes the frame again: a successfully completed run did not invoke
   * this unfinished frame, so it is no longer that branch's outcome. A settled frame is terminal
   * too: it is `completed` for a settled success and keeps `failed` for a settled failure.
   */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'suspended' | 'superseded';
  /** Start time of the latest body execution. */
  startedAt: string;
  /** Latest durable settlement or supersession time, or null for an active/parked frame. */
  finishedAt: string | null;
  /**
   * Latest body/validation failure or cancellation reason, or null. Supersession keeps an existing
   * reason and records its own only when there was none.
   */
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
