import { runBudgetSchema, type RunBudgetPolicy, type RunBudgetStop } from './run-budget.js';
import { agentUsageSchema } from './usage.js';
import type { ChildRecord } from './child-model.js';
import { mergePreparationSchema, type MergePreparation } from './worktree-schema.js';
import type { AgentDiagnostics, AgentTranscript } from './agent-stream-model.js';
import { agentDiagnosticsSchema, agentTranscriptSchema } from './agent-stream-schema.js';
import { environmentSummarySchema, hostEnvironmentSummarySchema } from './agent-environment.js';
import { harnessIsolationSchema } from './agent-isolation.js';
import {
  worktreeStepSchema,
  worktreeLedgerSchema,
  type WorktreeStep,
  type WorktreeLedger,
} from './worktree-schema.js';
import type { ExecSummary, ExecDiagnostics } from './exec-model.js';
import { execSummarySchema, execDiagnosticsSchema } from './exec-schema.js';
import { z } from 'zod';
import { questionRecordSchema, workflowLaunchSchema } from './question-schema.js';
import { waitRecordSchema } from './wait-schema.js';
import type { WaitRecord } from './wait-model.js';
import type { QuestionRecord, WorkflowLaunch } from './question-model.js';
import { MAX_RUN_EVENTS } from './observability.js';
import type {
  ExecutionRecord,
  PhaseInfo,
  RequestSummary,
  RunEvent,
} from './observability-model.js';
import { codexEffortValues } from './agent-controls.js';
import type {
  HarnessMetadata,
  AgentUsage,
  ErrorKind,
  JsonValue,
  Settled,
  StepError,
} from './model.js';
import { profileOverrideSchema, grantsSchema, capabilityManifestSchema } from './profiles.js';
import type { CapabilityManifest, ProfileOverride } from './profiles-model.js';
import { jsonValue } from './json.js';
import { errorKindSchema, retryOnSchema, stepErrorSchema } from './step-error.js';
import type { MapStepError, RootCause } from './fan-out.js';
import type { StepIdentity } from './identity.js';
import type { CodeChange, ForkProvenance, ReusedStep, WorkflowIdentity } from './replay-model.js';
import {
  executionPolicySchema,
  policyOverrideSchema,
  type AttemptPolicy,
  type PolicyOverride,
} from './policy.js';

/** One started effect attempt, including the policy actually sent to its adapter. */
export interface AttemptRecord extends AttemptPolicy {
  /** Observed native session ID, saved at first sight. */
  sessionId?: string | null;
  /** Predetermined Claude UUID, saved before spawning. */
  requestedSessionId?: string;
  /** Extensible bounded native metadata and warnings. */
  diagnostics?: AgentDiagnostics;
  /** Private transcript receipt, present even while the agent is running. */
  transcript?: AgentTranscript;
  /** Rejected native response, bounded to 256 KiB. */
  response?: string | null;
  /** Whether response exceeded its evidence budget. */
  responseTruncated?: boolean;
  /** Local Zod validation issues, when output was rejected. */
  validationIssues?: JsonValue[];
  /** Isolation base, cache path, and captured snapshot for this attempt. */
  worktree?: WorktreeStep;
  /** Command attempted, without environment values or stdin. */
  readonly exec?: ExecSummary;
  /** Bounded command failure diagnostics. */
  execError?: ExecDiagnostics;
  /** Body execution that started this attempt; absent in older formats. */
  readonly execution?: number;
  /** Monotonic attempt duration after settlement, including admission waiting. */
  durationMs?: number | null;
  /** Local helper attribution when usage was reported explicitly from its callback. */
  integration?: string;
  /** Reported usage, even if response validation failed. */
  usage?: AgentUsage | null;
  /** Original attempt stack/cause chain. */
  errorStack?: string | null;
  /** Resolved request sent on this attempt. */
  readonly request?: RequestSummary | null;

  /** Total attempt number across resumes. */
  readonly attempt: number;
  /** Identity fingerprint for this version of the effect. */
  readonly fingerprint: string;
  /** ISO timestamp saved before the effect starts. */
  readonly startedAt: string;
  /** ISO timestamp after settlement, or null for an interrupted attempt. */
  finishedAt: string | null;
  /** Last observed outcome; running may indicate an interrupted process. */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** Failure message, when available. */
  error: string | null;
  /** Classified failure for this attempt, when it failed. */
  errorKind?: ErrorKind;
}

/** Earlier identity of an unfinished effect that was explicitly redefined. */
export interface StepRedefinition {
  /** Previous semantic fingerprint. */
  readonly fingerprint: string;
  /** Previous component hashes. */
  readonly identity: StepIdentity;
  /** ISO time when the new identity was adopted. */
  readonly redefinedAt: string;
  /** Previous effect kind, so earlier attempts keep their provider; absent from older runtimes. */
  readonly kind?: StepRecord['kind'];
  /** Attempts started under the previous identity; absent from older runtimes. */
  readonly attempts?: number;
}

/** Usage recovered from one failed harness attempt, retained across resumes. */
export interface FailedAttempt {
  /** One-based attempt number within this effect. */
  readonly attempt: number;
  /** Native session identifier, when available. */
  readonly sessionId: string | null;
  /** Usage reported before failure, or null when the protocol did not report it. */
  readonly usage: AgentUsage | null;
}

/** Persisted state of one effect. */
export interface StepRecord {
  /** Owning inline workflow frame, or null/absent for the root. */
  frame?: string | null;
  /** Resolved inputs and target publication intent for a durable integration. */
  merge?: MergePreparation;
  /** Latest isolation state; resolved base remains pinned on unfinished retries. */
  worktree?: WorktreeStep;
  /** Latest command description; shell execution is explicit. */
  exec?: ExecSummary;
  /** Latest command failure diagnostics. */
  execError?: ExecDiagnostics;
  /** Bounded timing and observation progress for a durable wait. */
  wait?: WaitRecord;
  /** An original format-one identity awaiting verification by replay. */
  legacyIdentity?: 1;
  /** Attempts predating detailed history; counts are retained, unknown timings remain absent. */
  legacyAttempts?: number;
  /** Durable external question data; present only on ask effects. */
  question?: QuestionRecord;
  /** Observational phase at the latest live attempt, or null. */
  phase?: string | null;
  /** Start of the latest attempt, including admission waiting. */
  startedAt?: string | null;
  /** Latest settlement time, or null while running. */
  finishedAt?: string | null;
  /** Latest monotonic attempt duration; earlier attempts remain in history. */
  durationMs?: number | null;
  /** Latest resolved agent request; null for local steps and sleeps. */
  request?: RequestSummary | null;
  /** Latest failure stack/cause chain, or null. */
  errorStack?: string | null;

  /** Registered harness identity; required for new agent-kind records. */
  harness?: string;
  /** Registered option-semantics revision, independent of native executable version. */
  revision?: number;
  /** Observational helper labels, never effect identity. */
  meta?: Record<string, JsonValue>;
  /** Effect category; included in replay compatibility checks. Legacy built-in kinds remain readable. */
  kind:
    | 'step'
    | 'agent'
    | 'claude'
    | 'codex'
    | 'sleep'
    | 'ask'
    | 'wait'
    | 'exec'
    | 'read-file'
    | 'write-file'
    | 'worktree'
    | 'merge';
  /** Hash of semantic components, including error mode. */
  fingerprint: string;
  /** Last saved lifecycle state. */
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'settled-failed'
    | 'superseded'
    | 'waiting'
    | 'withdrawn';
  /** Effect that cancelled this scope, or null for an interrupt/mapper-body failure. */
  cancelledBy?: string | null;
  /** Terminal failure returned to the workflow by onError: return. */
  settledError?: StepError;
  /** Semantic component hashes; absent in version 1 checkpoints. */
  identity?: StepIdentity;
  /** Prior identities of unfinished effects. */
  redefinitions?: StepRedefinition[];
  /** Per-attempt execution limits, provenance, and outcome. */
  attemptHistory?: AttemptRecord[];
  /** First-use ordering within this run; present from format 3. */
  seq?: number;
  /**
   * The run's settlement counter when the workflow body last requested this effect live. It is
   * stamped synchronously at the call, before any awaited preparation, so an effect launched in the
   * same tick as a sibling that later fails is stamped before that failure. Replays keep it; a live
   * relaunch on resume restamps it. Absent in checkpoints saved before launch stamps existed, and
   * on replayed legacy steps.
   */
  launchStamp?: number;
  /**
   * The run's settlement counter after this step's latest terminal settlement (completed, terminal
   * failure, settled failure or cancellation). Each settlement increments the counter, so
   * `x.settleStamp <= y.launchStamp` means x had settled when y was launched. Absent before the
   * step first settles and in older checkpoints.
   */
  settleStamp?: number;
  /**
   * The `settleStamp` of this step's first terminal failure since it last completed. A healed step
   * flags only recorded steps whose `launchStamp` is at least this value (they were launched after
   * the failure could be observed). Removed when the step completes; absent in older checkpoints
   * and after a failure saved between retries, where the runner falls back to `seq` order.
   */
  failureStamp?: number;
  /** Source checkpoint of a reused completed effect. */
  reusedFrom?: ReusedStep;
  /** Total started attempts across resumes. */
  attempts: number;
  /** Serialized result; null until completed. */
  output: JsonValue;
  /** Last error message, if any. */
  error: string | null;
  /** Persisted deadline for sleep steps. */
  wakeAt: number | null;
  /** Failed harness attempt measurements; absent in older checkpoints. */
  failedAttempts?: FailedAttempt[];
  /** Recoverable harness notices; independent of the agent result and its fingerprint. */
  warnings?: readonly string[];
}

/** One settled mapper's owned records and saved outcome. */
export interface MapItemRecord {
  /** Inline frames owned by this mapper, claimed without rerunning it on settled replay. */
  children?: string[];
  /** Running items are retried; completed items replay the entire saved outcome. */
  status: 'running' | 'completed';
  /** Serialized mapper result/failure, or null until committed. */
  outcome: Settled<JsonValue, MapStepError> | null;
  /** Owned leaf IDs, including failed children whose outcome this item contains. */
  steps: string[];
  /** Owned nested map journal IDs. */
  maps: string[];
}

/**
 * One digest per component of a settled map's identity, saved beside the aggregate `fingerprint` so
 * a changed map can name what changed. Only `mapper` may change after an item completed, and only
 * under an explicit `acceptCodeChange`.
 */
export interface MapComponents {
  /** Digest of the JSON item inputs. */
  items: string;
  /** Digest of the original mapper function's source text. */
  mapper: string;
  /** Digest of the map `version` option, or of null without one. */
  version: string;
  /** Digest of the run working directory. */
  cwd: string;
  /** Digest of the resolved item keys; present only for a named map. */
  keys?: string;
}

/** Journal for an explicitly identified settled map. */
export interface MapRecord {
  /** Hash of item inputs, mapper source, optional version, cwd and, for a named map, keys. */
  fingerprint: string;
  /**
   * Per-component digests of the same identity; absent in journals saved before they existed, whose
   * changed component cannot be named.
   */
  components?: MapComponents;
  /** First-use ordering shared with step seq values; absent in journals saved before it existed. */
  seq?: number;
  /** Partially evaluated or completely settled collection. */
  status: 'running' | 'completed';
  /** Item journals in input order. */
  items: MapItemRecord[];
}

/** Local checkpoint format. The format is intentionally versioned independently of workflows. */
export interface RunRecord {
  /** Inline child invocations keyed by runtime frame ID. */
  children?: Record<string, ChildRecord>;
  /** Sticky nesting guard; root depth is zero. Not part of replay identity. */
  maxChildDepth?: number;
  /** Sticky operator caps; omission in old records means unlimited. */
  runBudget?: RunBudgetPolicy;
  /** Latest budget refusal, without a corresponding agent attempt. */
  budgetStop?: RunBudgetStop;
  /**
   * Tick's crash-loop counter for automatic recovery of a `running` run whose owner is gone. Only
   * tick writes it, under ownership, before resuming; a clean suspension or completion removes it.
   */
  staleRecovery?: {
    /** Consecutive stale recoveries without a new completed step, starting at 1. */
    count: number;
    /** Completed steps when the latest recovery started; a different value resets the count. */
    completedSteps: number;
    /** When tick last recorded a recovery. */
    at: string;
  };
  /**
   * Why the latest execution was interrupted into a resumable `suspended` state, when an abort with
   * a `RunInterruptedError` reason (a CLI signal or tick's deadline) stopped it. Cleared when a
   * later execution starts.
   */
  interruptedBy?: {
    /** The interruption's message, such as `Tick timeout reached.`. */
    reason: string;
    /** When the interrupted execution saved its suspension. */
    at: string;
  };
  /** Random UUID namespace used to derive Claude attempt session IDs. */
  sessionSalt?: string;
  /** Runtime-owned worktree caches, handles, and durable pins. */
  worktrees?: WorktreeLedger;
  /** Nonfatal isolation and cache cleanup diagnostics. */
  worktreeWarnings?: string[];
  /** Nonfatal poll-observer abandonment diagnostics, deduplicated and capped at 20. */
  waitWarnings?: string[];
  /** Earliest parked deadline/poll; null when only an external signal can wake the run. */
  nextWakeAt?: number | null;
  /** Source launch metadata for resume by ID; absent for older and embedded runs. */
  launch?: WorkflowLaunch;
  /** Harness provenance, absent in checkpoints created before rehearsal support. */
  harness?: {
    /** Adapter kind used by the latest body execution. */
    kind: string;
    /** Earlier kinds whose outputs were explicitly accepted for reuse. */
    previousKinds: string[];
    /**
     * SHA-256 of the resolved CLI harness configuration at the latest live execution. Absent in
     * older records and for executions whose configuration is unknown (an embedder's own harness).
     */
    configDigest?: string;
  };
  /** Workflow-body execution history, introduced in format 6. */
  executions?: ExecutionRecord[];
  /** Recent lifecycle, phase, and log payloads; capped at 500 entries. */
  events?: RunEvent[];
  /** Maximum occurrence counts by phase/log signature, retained across payload eviction. */
  eventCounts?: Record<string, number>;
  /** Most recently entered active phase, or the root phase. */
  phase?: PhaseInfo | null;
  /** Latest run failure stack/cause chain, or null. */
  errorStack?: string | null;

  /** Native harness binary/version from latest live use, with nonfatal version drift diagnostics. */
  harnesses?: Record<string, HarnessMetadata>;
  /** Discovery/version warnings retained across resume. */
  harnessWarnings?: string[];
  /** Resolved declared capabilities at the latest execution. Absent in older format-5 records. */
  capabilities?: CapabilityManifest;
  /** Sticky profile limit rules. */
  profileOverrides?: ProfileOverride[];
  /** Persisted operator grants; forks require their own grants. */
  grants?: string[];
  /** Capability digests pinning profile-name grants against source edits. */
  grantedProfiles?: Record<string, string>;
  /** Checkpoint format version. */
  formatVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Last applied storage journal sequence; present in the directory layout. */
  seq?: number;
  /** Informational runtime versions, excluded from workflow and step identity. */
  engine?: {
    /** Informational quiet-choir package version. */
    quietChoir: string;
    /** Informational Node.js version, including its v prefix. */
    node: string;
    /** Informational zod version whose JSON Schema encoding fed schema identity; absent in older records. */
    zod?: string;
    /** Informational tsx version that loaded workflow source; absent in older records. */
    tsx?: string;
  };
  /** Stable run identifier. */
  id: string;
  /** Workflow compatibility metadata. */
  workflow: {
    /** User-defined workflow name. */
    name: string;
    /** User-defined compatibility version. */
    version: string;
    /** Optional caller-supplied code fingerprint. */
    fingerprint: string | null;
    /** Component hashes and engine compatibility, present from format 3. */
    identity?: WorkflowIdentity;
  };
  /** Absolute working directory, fixed across resumes. */
  cwd: string;
  /** Validated original workflow input. */
  input: JsonValue;
  /** Validated final output, or null before completion. */
  output: JsonValue;
  /** Run lifecycle status. */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'suspended';
  /** Last workflow error, if any. */
  error: string | null;
  /** First failure responsible for this invocation, or null after success; present from format 5. */
  rootCause?: RootCause | null;
  /** Durable settled-map outcomes, keyed by explicit map ID; present from format 5. */
  maps?: Record<string, MapRecord>;
  /** Named checkpoints. Step IDs are unique within one run. */
  steps: Record<string, StepRecord>;
  /** Sticky rules; subsequent invocations append unless policyReset is requested. */
  policy?: PolicyOverride[];
  /** Persisted authorization for saved model/effort overrides. */
  allowModelOverride?: boolean;
  /** Rules that matched no visited step during the latest invocation. */
  policyWarnings?: string[];
  /** Source snapshot and reuse progress, if this run was forked. */
  forkedFrom?: ForkProvenance;
  /** Explicit source/schema acceptance history. */
  codeChanges?: CodeChange[];
  /** Replay-order warnings from the latest invocation. */
  replayWarnings?: string[];
  /**
   * Recovery advice for a failed or cancelled run, chosen by its typed failure cause: `--grant` for
   * a missing grant, `--strict-replay` for a replay divergence, re-finalizing with
   * `--accept-code-change` for a configuration or authoring failure, or a plain resume. Absent when
   * the run recorded nothing or was a dry-run.
   */
  recoveryHint?: string;
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO timestamp of the most recent persisted change. */
  updatedAt: string;
}

// Preserve valid JSON keys such as __proto__. Zod's object/record clones omit them.
const jsonSchema = z.custom<JsonValue>((value) => {
  try {
    jsonValue(value);
    return true;
  } catch {
    return false;
  }
});
const reusedStepSchema = z.object({
  runId: z.string(),
  stateDir: z.string(),
  stepId: z.string(),
  fingerprint: z.string(),
  at: z.iso.datetime(),
});
const workflowIdentitySchema = z.object({
  code: z.string().nullable(),
  files: z.record(z.string(), z.string()),
  inputSchema: z.string(),
  outputSchema: z.string(),
  engine: z.object({ version: z.string(), formatVersion: z.number().int().positive() }),
});
const requestSummarySchema = z
  .object({
    isolation: harnessIsolationSchema.optional(),
    instructions: z.enum(['native', 'none']).optional(),
    environment: environmentSummarySchema.optional(),
    harness: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/u)
      .optional(),
    provider: z.enum(['claude', 'codex']).optional(),
    revision: z.number().int().positive().optional(),
    model: z.string().nullable(),
    profile: z.string().nullable(),
    limits: z.object({
      timeoutMs: z.number().positive().nullable(),
      maxTurns: z.number().int().positive().nullable(),
      maxBudgetUsd: z.number().nonnegative().nullable(),
      sandbox: z.string().nullable(),
      killGraceMs: z.number().positive().nullable(),
    }),
    tools: z.array(z.string()).nullable(),
    cwd: z.string(),
    structured: z.boolean(),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    promptPreview: z.string().max(200),
  })
  .refine(
    (value) => value.harness !== undefined || value.provider !== undefined,
    'Request summary requires a harness.',
  );
const usageSchema = agentUsageSchema;

const timingFields = {
  exec: execSummarySchema.optional(),
  execError: execDiagnosticsSchema.optional(),
  startedAt: z.iso.datetime().nullable().optional(),
  finishedAt: z.iso.datetime().nullable().optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  errorStack: z.string().nullable().optional(),
  request: requestSummarySchema.nullable().optional(),
};
const stepKindSchema = z.enum([
  'step',
  'agent',
  'claude',
  'codex',
  'sleep',
  'ask',
  'wait',
  'exec',
  'read-file',
  'write-file',
  'worktree',
  'merge',
]);
const stepSchema = z
  .object({
    frame: z.string().nullable().optional(),
    merge: mergePreparationSchema.optional(),
    worktree: worktreeStepSchema.optional(),
    legacyIdentity: z.literal(1).optional(),
    legacyAttempts: z.number().int().nonnegative().optional(),
    question: questionRecordSchema.optional(),
    wait: waitRecordSchema.optional(),
    ...timingFields,
    phase: z.string().nullable().optional(),
    harness: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/u)
      .optional(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    meta: z.record(z.string(), z.json()).optional(),
    kind: stepKindSchema,
    seq: z.number().int().positive().optional(),
    launchStamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    settleStamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    failureStamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    reusedFrom: reusedStepSchema.optional(),
    fingerprint: z.string(),
    status: z.enum([
      'running',
      'completed',
      'failed',
      'cancelled',
      'settled-failed',
      'superseded',
      'waiting',
      'withdrawn',
    ]),
    cancelledBy: z.string().nullable().optional(),
    settledError: stepErrorSchema.optional(),
    identity: z.record(z.string(), z.string()).optional(),
    redefinitions: z
      .array(
        z.object({
          fingerprint: z.string(),
          identity: z.record(z.string(), z.string()),
          redefinedAt: z.iso.datetime(),
          kind: stepKindSchema.optional(),
          attempts: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
    attemptHistory: z
      .array(
        z.object({
          sessionId: z.string().nullable().optional(),
          requestedSessionId: z.uuid().optional(),
          diagnostics: agentDiagnosticsSchema.optional(),
          transcript: agentTranscriptSchema.optional(),
          response: z.string().nullable().optional(),
          responseTruncated: z.boolean().optional(),
          validationIssues: z.array(jsonSchema).optional(),
          worktree: worktreeStepSchema.optional(),
          execution: z.number().int().positive().optional(),
          exec: execSummarySchema.optional(),
          execError: execDiagnosticsSchema.optional(),
          durationMs: z.number().nonnegative().nullable().optional(),
          usage: usageSchema.nullable().optional(),
          errorStack: z.string().nullable().optional(),
          request: requestSummarySchema.nullable().optional(),
          integration: z.string().min(1).max(100).optional(),
          attempt: z.number().int().positive(),
          fingerprint: z.string(),
          startedAt: z.iso.datetime(),
          finishedAt: z.iso.datetime().nullable(),
          status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
          error: z.string().nullable(),
          errorKind: errorKindSchema.optional(),
          policy: executionPolicySchema.extend({
            retry: z.object({
              maxAttempts: z.number().int().positive(),
              delayMs: z.number().nonnegative(),
              on: z.array(retryOnSchema).optional(),
            }),
          }),
          sources: z.record(z.string(), z.string()),
          profile: z.string().optional(),
          requestedModel: z.string().nullable(),
          reasoningEffort: z.enum(codexEffortValues).nullable(),
          requested: z.object({ model: z.string(), effort: z.string() }).optional(),
        }),
      )
      .optional(),
    attempts: z.number().int().nonnegative(),
    output: jsonSchema,
    error: z.string().nullable(),
    wakeAt: z.number().nullable(),
    warnings: z.array(z.string()).optional(),
    failedAttempts: z
      .array(
        z.object({
          attempt: z.number().int().positive(),
          sessionId: z.string().nullable(),
          usage: z
            .object({
              inputTokens: z.number().nonnegative().nullable(),
              outputTokens: z.number().nonnegative().nullable(),
              costUsd: z.number().nonnegative().nullable(),
            })
            .nullable(),
        }),
      )
      .optional(),
  })
  .refine(
    (step) => step.kind !== 'agent' || (step.harness !== undefined && step.revision !== undefined),
    'Agent records require harness and revision.',
  );
const stepsSchema = z.custom<Record<string, StepRecord>>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((step) => stepSchema.safeParse(step).success),
);
const recordFieldsSchema = z.object({
  maxChildDepth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  children: z
    .record(
      z.string(),
      z.object({
        declared: z.boolean(),
        label: z.string().min(1),
        workflow: z.object({ name: z.string().min(1), version: z.string().min(1) }),
        parent: z.string().nullable(),
        depth: z.number().int().positive(),
        inputDigest: z.string(),
        schemaDigest: z.string(),
        status: z.enum(['running', 'completed', 'failed', 'cancelled', 'suspended', 'superseded']),
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime().nullable(),
        error: z.string().nullable(),
      }),
    )
    .optional(),
  worktrees: worktreeLedgerSchema.optional(),
  worktreeWarnings: z.array(z.string()).optional(),
  waitWarnings: z.array(z.string()).optional(),
  nextWakeAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  launch: workflowLaunchSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  engine: z
    .object({
      quietChoir: z.string(),
      node: z.string(),
      zod: z.string().optional(),
      tsx: z.string().optional(),
    })
    .optional(),
  formatVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
  ]),
  runBudget: runBudgetSchema.optional(),
  budgetStop: z
    .object({
      stepId: z.string(),
      metric: z.enum(['maxRunCostUsd', 'maxRunAgentAttempts']),
      limit: z.number().nonnegative(),
      observed: z.number().nonnegative(),
      at: z.iso.datetime(),
    })
    .optional(),
  staleRecovery: z
    .object({
      count: z.number().int().positive(),
      completedSteps: z.number().int().nonnegative(),
      at: z.iso.datetime(),
    })
    .optional(),
  interruptedBy: z.object({ reason: z.string(), at: z.iso.datetime() }).optional(),
  sessionSalt: z.uuid().optional(),
  executions: z
    .array(
      z.object({
        n: z.number().int().positive(),
        pid: z.number().int().positive(),
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime().nullable(),
        outcome: z.enum(['running', 'completed', 'failed', 'cancelled', 'suspended']),
        error: z.string().nullable(),
        errorStack: z.string().nullable(),
      }),
    )
    .optional(),
  events: z
    .array(
      z.object({
        at: z.iso.datetime(),
        execution: z.number().int().positive(),
        type: z.enum([
          'run.started',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'run.suspended',
          'phase',
          'log',
        ]),
        phase: z.string().nullable(),
        total: z.number().int().nonnegative().nullable(),
        message: z.string().nullable(),
        data: jsonSchema,
        stepId: z.string().nullable(),
        frame: z.string().nullable().optional(),
      }),
    )
    .max(MAX_RUN_EVENTS)
    .optional(),
  eventCounts: z
    .record(z.string().regex(/^[a-f0-9]{64}$/u), z.number().int().positive())
    .optional(),
  phase: z
    .object({ title: z.string().min(1), total: z.number().int().nonnegative().nullable() })
    .nullable()
    .optional(),
  errorStack: z.string().nullable().optional(),
  id: z.string(),
  workflow: z.object({
    name: z.string(),
    version: z.string(),
    fingerprint: z.string().nullable(),
    identity: workflowIdentitySchema.optional(),
  }),
  cwd: z.string(),
  input: jsonSchema,
  output: jsonSchema,
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'suspended']),
  error: z.string().nullable(),
  steps: stepsSchema,
  rootCause: z
    .object({
      stepId: z.string().nullable(),
      error: z.string(),
      errorKind: errorKindSchema.nullable().optional(),
      effect: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  maps: z
    .record(
      z.string(),
      z.object({
        fingerprint: z.string(),
        components: z
          .object({
            items: z.string(),
            mapper: z.string(),
            version: z.string(),
            cwd: z.string(),
            keys: z.string().optional(),
          })
          .optional(),
        seq: z.number().int().positive().optional(),
        status: z.enum(['running', 'completed']),
        items: z.array(
          z.object({
            status: z.enum(['running', 'completed']),
            outcome: z
              .discriminatedUnion('ok', [
                z.object({ ok: z.literal(true), value: jsonSchema }),
                z.object({
                  ok: z.literal(false),
                  error: stepErrorSchema.extend({ stepId: z.string().nullable() }),
                }),
              ])
              .nullable(),
            steps: z.array(z.string()),
            maps: z.array(z.string()),
            children: z.array(z.string()).optional(),
          }),
        ),
      }),
    )
    .optional(),
  harness: z
    .object({
      kind: z.string().min(1).max(100),
      previousKinds: z.array(z.string().min(1).max(100)),
      configDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .optional(),
  harnesses: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
      z.object({
        environment: hostEnvironmentSummarySchema.optional(),
        binary: z.string(),
        version: z.string().nullable(),
        warnings: z.array(z.string()).optional(),
        instructionSources: z
          .array(
            z.object({
              scope: z.enum(['user', 'project']),
              kind: z.enum(['agents', 'agents-override', 'skill']),
              path: z.string(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  harnessWarnings: z.array(z.string()).optional(),
  capabilities: capabilityManifestSchema.optional(),
  profileOverrides: z.array(profileOverrideSchema).optional(),
  grants: grantsSchema.optional(),
  grantedProfiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  policy: z.array(policyOverrideSchema).optional(),
  allowModelOverride: z.boolean().optional(),
  policyWarnings: z.array(z.string()).optional(),
  forkedFrom: z
    .object({
      runId: z.string(),
      stateDir: z.string(),
      sourceDigest: z.string(),
      fingerprint: z.string().nullable(),
      reuse: z.enum(['prefix', 'matching']),
      invalidate: z.array(z.string()),
      differences: z.array(z.string()),
      at: z.iso.datetime(),
      cursor: z.number().int().nonnegative(),
      reuseClosed: z.boolean(),
      warning: z.string().optional(),
    })
    .optional(),
  codeChanges: z
    .array(
      z.object({
        at: z.iso.datetime(),
        from: z.string().nullable(),
        to: z.string(),
        files: z.array(z.string()),
        components: z.array(z.string()),
        map: z.string().optional(),
      }),
    )
    .optional(),
  replayWarnings: z.array(z.string()).optional(),
  recoveryHint: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const recordSchema = recordFieldsSchema.superRefine((record, context) => {
  if (record.formatVersion === 7 && (record.seq === undefined || record.engine === undefined))
    context.addIssue({
      code: 'custom',
      message: 'Directory checkpoint is missing journal metadata',
    });
  if (
    record.formatVersion < 6 &&
    (record.status === 'suspended' ||
      Object.values(record.steps).some(
        (step) =>
          step.kind === 'ask' ||
          step.question !== undefined ||
          ['waiting', 'withdrawn'].includes(step.status),
      ))
  )
    context.addIssue({ code: 'custom', message: 'Questions require format 6 or newer' });
  if (record.formatVersion === 1) return;
  if (record.formatVersion >= 6) {
    if (
      !record.executions?.length ||
      record.events === undefined ||
      record.eventCounts === undefined ||
      record.phase === undefined ||
      record.errorStack === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint is missing observability metadata',
      });
    for (const [id, step] of Object.entries(record.steps)) {
      if (
        step.phase === undefined ||
        step.startedAt === undefined ||
        step.finishedAt === undefined ||
        step.durationMs === undefined ||
        step.request === undefined ||
        step.errorStack === undefined ||
        step.attemptHistory?.some(
          (attempt) =>
            attempt.execution === undefined ||
            attempt.durationMs === undefined ||
            attempt.usage === undefined ||
            attempt.errorStack === undefined ||
            attempt.request === undefined,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['steps', id],
          message: 'Step is missing observability metadata',
        });
    }
  }
  if (record.formatVersion >= 5) {
    if (record.maps === undefined || record.rootCause === undefined)
      context.addIssue({ code: 'custom', message: 'Checkpoint is missing scope metadata' });
    for (const [id, map] of Object.entries(record.maps ?? {})) {
      for (const item of map.items) {
        if (
          (item.status === 'completed') !== (item.outcome !== null) ||
          (map.status === 'completed' && item.status !== 'completed') ||
          (item.outcome?.ok === false && item.outcome.error.kind === 'cancelled') ||
          item.steps.some((stepId) => !Object.hasOwn(record.steps, stepId)) ||
          item.maps.some((mapId) => !Object.hasOwn(record.maps ?? {}, mapId))
        )
          context.addIssue({
            code: 'custom',
            path: ['maps', id],
            message: 'Invalid settled map journal or owned record references',
          });
      }
    }
  }
  if (record.policy === undefined || record.allowModelOverride === undefined)
    context.addIssue({
      code: 'custom',
      message: 'Checkpoint is missing execution policy metadata',
    });
  if (record.formatVersion >= 3 && record.workflow.identity === undefined)
    context.addIssue({
      code: 'custom',
      message: 'Checkpoint is missing workflow identity',
    });
  const sequences = new Set<number>();
  for (const [id, step] of Object.entries(record.steps)) {
    if (step.kind === 'agent' && (step.harness === undefined || step.revision === undefined))
      context.addIssue({
        code: 'custom',
        path: ['steps', id],
        message: 'Agent step is missing harness identity or revision',
      });
    const signalCompleted =
      step.status === 'completed' &&
      (step.kind === 'ask' ||
        (step.kind === 'wait' &&
          step.output !== null &&
          typeof step.output === 'object' &&
          !Array.isArray(step.output) &&
          step.output['by'] === 'signal'));
    if (
      (step.kind === 'ask' && step.question === undefined) ||
      (step.question !== undefined && !['ask', 'wait'].includes(step.kind)) ||
      (['waiting', 'withdrawn'].includes(step.status) && !['ask', 'wait'].includes(step.kind)) ||
      (['ask', 'wait'].includes(step.kind) &&
        !['waiting', 'withdrawn', 'completed', 'superseded'].includes(step.status)) ||
      (step.question && signalCompleted !== (step.question.resolution !== null)) ||
      (step.kind === 'wait' && step.wait === undefined) ||
      (step.wait !== undefined &&
        (record.formatVersion < 7 || !['ask', 'wait'].includes(step.kind)))
    )
      context.addIssue({
        code: 'custom',
        path: ['steps', id],
        message: 'Invalid question state',
      });
    if (
      step.status === 'settled-failed' &&
      (record.formatVersion < 4 ||
        step.settledError === undefined ||
        step.settledError.kind === 'cancelled')
    )
      context.addIssue({
        code: 'custom',
        path: ['steps', id],
        message: 'Settled failures require format 4 and a non-cancellation outcome',
      });
    if (record.formatVersion >= 3) {
      if (step.seq === undefined || sequences.has(step.seq))
        context.addIssue({
          code: 'custom',
          path: ['steps', id, 'seq'],
          message: 'Steps require unique positive seq values',
        });
      else sequences.add(step.seq);
    }
    if (step.identity === undefined || step.attemptHistory === undefined)
      context.addIssue({
        code: 'custom',
        path: ['steps', id],
        message: 'Step is missing identity or attempt history',
      });
  }
});

/** Validate bytes from an atomic checkpoint read, including synchronous interrupt reporting. @internal */
export function parseRunRecord(text: string, runId: string): RunRecord {
  const raw = jsonValue(JSON.parse(text));
  const record = recordSchema.parse(raw);
  if (record.id !== runId) throw new Error('Checkpoint run ID does not match its filename.');
  return normalizeStoredHarnesses(record as RunRecord);
}

/** Normalize read views only; original checkpoint bytes and native identity digests remain untouched. @internal */
export function normalizeStoredHarnesses(record: RunRecord): RunRecord {
  const summary = (value: RequestSummary | null | undefined): void => {
    if (!value) return;
    const legacy: unknown = Reflect.get(value, 'provider');
    if (!Object.hasOwn(value, 'harness') && typeof legacy === 'string')
      Object.assign(value, { harness: legacy });
    Reflect.deleteProperty(value, 'provider');
  };
  for (const step of Object.values(record.steps)) {
    if (record.formatVersion !== 1 && (step.kind === 'claude' || step.kind === 'codex')) {
      step.harness = step.kind;
      step.revision = 1;
      step.kind = 'agent';
    }
    summary(step.request);
    for (const attempt of step.attemptHistory ?? []) summary(attempt.request);
  }
  return record;
}

/** An outcome already observed by the workflow that must be preserved on replay. @internal */
export function isTerminalStep(step: StepRecord): boolean {
  return step.status === 'completed' || step.status === 'settled-failed';
}

/**
 * Whether the run recorded at least one step or map and all of that work can replay without
 * executing an unfinished item/effect. A record with nothing recorded has no outcomes to reuse, so
 * this is false for it. @internal
 */
export function hasTerminalOutcomes(record: RunRecord): boolean {
  if (!Object.keys(record.steps).length && !Object.keys(record.maps ?? {}).length) return false;
  const steps = new Set<string>();
  const maps = new Set<string>();
  for (const map of Object.values(record.maps ?? {})) {
    for (const item of map.items) {
      if (item.status !== 'completed') continue;
      for (const id of item.steps) steps.add(id);
      for (const id of item.maps) maps.add(id);
    }
  }
  return (
    Object.entries(record.steps).every(([id, step]) => isTerminalStep(step) || steps.has(id)) &&
    Object.entries(record.maps ?? {}).every(
      ([id, map]) => maps.has(id) || map.items.every((item) => item.status === 'completed'),
    )
  );
}

/** Validate a full snapshot at read, initial-write, or import boundaries. @internal */
export function validateRunRecord(value: unknown): void {
  recordSchema.parse(value);
}

/** Validate only a field/effect/map changed by one new storage journal entry. @internal */
export function validateRecordChange(
  area: 'run' | 'steps' | 'maps' | 'children',
  key: string,
  value: unknown,
): void {
  if (area === 'run') {
    if (
      ['seq', 'formatVersion', 'id', 'steps', 'maps', 'children'].includes(key) ||
      !Object.hasOwn(recordFieldsSchema.shape, key)
    )
      throw new Error(`Invalid storage journal field ${key}.`);
    recordFieldsSchema.shape[key as keyof typeof recordFieldsSchema.shape].parse(value);
  } else if (value !== undefined) {
    if (area === 'steps') stepSchema.parse(value);
    else if (area === 'maps') recordFieldsSchema.shape.maps.unwrap().valueType.parse(value);
    else recordFieldsSchema.shape.children.unwrap().valueType.parse(value);
  }
}
