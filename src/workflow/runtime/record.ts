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
  InstructionSource,
  AgentUsage,
  ErrorKind,
  JsonValue,
  Settled,
  StepError,
} from './model.js';
import { profileOverrideSchema, grantsSchema, capabilityManifestSchema } from './profiles.js';
import type { CapabilityManifest, ProfileOverride } from './profiles-model.js';
import { jsonValue } from './json.js';
import { RunRefusedError } from './run-errors.js';
import { errorKindSchema, retryOnSchema, stepErrorSchema } from './step-error.js';
import type { MapStepError, RootCause } from './fan-out.js';
import type { RecoveryCause } from './recovery-hint.js';
import type { StepIdentity } from './identity.js';
import type { CodeChange, ForkProvenance, ReusedStep, WorkflowIdentity } from './replay-model.js';
import { renameLegacyEffort } from './effort-compat.js';
import {
  executionPolicySchema,
  storedPolicyOverrideSchema,
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

/** One terminal failure in a step's {@link StepRecord.failureHistory}. */
export interface FailureEntry {
  /** The `launchStamp` of the execution that failed. */
  readonly launchStamp: number;
  /** The `settleStamp` of its terminal failure. */
  readonly failureStamp: number;
}

/** Most `failureHistory` entries a step keeps; the oldest is dropped first. @internal */
export const MAX_FAILURE_HISTORY = 8;

/**
 * Record a terminal failure settled at `stamp` on `step`: keep the first `failureStamp` since the
 * step last completed and append the failing launch to `failureHistory`, dropping the oldest
 * entries beyond {@link MAX_FAILURE_HISTORY}. A step without a `launchStamp` loses its history
 * instead, so the healed check falls back to the `failureStamp` watermark rather than trusting a
 * history with a gap. @internal
 */
export function recordTerminalFailure(step: StepRecord, stamp: number): void {
  step.failureStamp ??= stamp;
  if (step.launchStamp === undefined) {
    delete step.failureHistory;
    return;
  }
  const history = [
    ...(step.failureHistory ?? []),
    { launchStamp: step.launchStamp, failureStamp: stamp },
  ];
  step.failureHistory = history.slice(-MAX_FAILURE_HISTORY);
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
   * the failure could be observed), narrowed per launch by `failureHistory` when that history is
   * complete. Kept through a later cancellation or interruption, so a step carrying it takes part
   * in the healed check when it completes. Removed when the step completes; absent in older
   * checkpoints and after a failure saved between retries, where the runner falls back to `seq`
   * order.
   */
  failureStamp?: number;
  /**
   * The terminal failures since this step last completed, oldest first: each pairs the launch that
   * failed with the failure's `settleStamp`. It explains which failure a later launch of another
   * step could observe, so a healed step flags a sibling relaunched alongside a later failing
   * launch only when it launched after that launch's failure. Holds at most
   * {@link MAX_FAILURE_HISTORY} entries (the oldest is dropped first), is kept through
   * cancellations and interruptions, and is removed with `failureStamp` when the step completes.
   * Absent in checkpoints saved before schema revision 12; when it is absent or its first entry is
   * not `failureStamp` (truncated), the healed check uses the `failureStamp` watermark.
   */
  failureHistory?: FailureEntry[];
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
  /**
   * Inline child frame that ran the map, absent at the root and in journals saved before revision
   * 8. A bound view can give the map an ID outside the frame's prefix. A journal with nothing
   * committed adopts the frame that runs it next; a committed one refuses to run in another frame.
   */
  frame?: string;
  /** First-use ordering shared with step seq values; absent in journals saved before it existed. */
  seq?: number;
  /** Partially evaluated or completely settled collection. */
  status: 'running' | 'completed';
  /** Item journals in input order. */
  items: MapItemRecord[];
}

/** Project-level instruction sources one harness reported for one working directory. */
export interface ProjectInstructionsRecord {
  /** Registered harness name. */
  harness: string;
  /** Resolved working directory of the call, including any runtime-owned worktree. */
  cwd: string;
  /** Files found, as paths and digests; empty when detection found none. */
  sources: InstructionSource[];
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
  /**
   * Project-level instruction files detected once per harness and distinct resolved cwd, isolation
   * mode and env edits per run invocation, oldest first; capped at 128 entries. The first detection
   * of a harness and cwd in a run invocation replaces its entry and later ones merge into it.
   * Diagnostic only, never step identity.
   */
  projectInstructions?: ProjectInstructionsRecord[];
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
  /**
   * Revision of the persisted run-level fields, independent of {@link RunRecord.formatVersion}.
   * Absent means revision 1, which covers every record written before the field existed. A build
   * refuses to resume, tick, fork or clean a record with a newer revision, or with top-level fields
   * it does not know, because rewriting it would drop them, and check-resume reports it
   * incompatible; read paths warn instead.
   */
  schemaRevision?: number;
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
   * `--accept-code-change` for a configuration or authoring failure, resuming with a higher value
   * of the stopping cap's flag (or the flag off) for a run-budget stop, or a plain resume. Absent
   * when the run recorded nothing or was a dry-run.
   */
  recoveryHint?: string;
  /**
   * The typed cause behind `recoveryHint` and the failed run's `next` commands, saved on every
   * failed or cancelled run, including one that recorded nothing or was a dry-run (which get no
   * hint and no commands). Absent after success, on a suspension, and on records from builds before
   * schema revision 10, whose failed runs get a plain resume command.
   */
  recoveryCause?: RecoveryCause;
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
      idleTimeoutMs: z.number().positive().nullable().optional(),
      maxTurns: z.number().int().positive().nullable(),
      maxBudgetUsd: z.number().nonnegative().nullable(),
      sandbox: z.string().nullable(),
      killGraceMs: z.number().positive().nullable(),
    }),
    tools: z.array(z.string()).nullable(),
    addDirs: z.array(z.string()).optional(),
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
    failureHistory: z
      .array(
        z.object({
          launchStamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          failureStamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .max(MAX_FAILURE_HISTORY)
      .optional(),
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
        z
          .object({
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
            // Attempts written before #341 spell the Codex effort reasoningEffort.
            effort: z.enum(codexEffortValues).nullable().optional(),
            reasoningEffort: z.enum(codexEffortValues).nullable().optional(),
            requested: z.object({ model: z.string(), effort: z.string() }).optional(),
          })
          .refine(
            (attempt) => (attempt.effort === undefined) !== (attempt.reasoningEffort === undefined),
            'An attempt records exactly one of effort or legacy reasoningEffort.',
          ),
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
/** One recorded instruction source, as a path and digest. @internal */
export const instructionSourceSchema = z.object({
  scope: z.enum(['user', 'project']),
  kind: z.enum(['agents', 'agents-override', 'skill', 'claude-md']),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

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
      z
        .object({
          declared: z.boolean(),
          label: z.string().min(1),
          workflow: z.object({ name: z.string().min(1), version: z.string().min(1) }),
          parent: z.string().nullable(),
          depth: z.number().int().positive(),
          inputDigest: z.string(),
          schemaDigest: z.string(),
          // Revision 3 (#170): a settled frame's mode and terminal outcome.
          onError: z.literal('return').optional(),
          settled: z
            .object({
              outcome: z.discriminatedUnion('ok', [
                z.object({ ok: z.literal(true), value: jsonSchema }),
                z.object({
                  ok: z.literal(false),
                  error: stepErrorSchema.extend({ stepId: z.string().nullable() }),
                }),
              ]),
              steps: z.array(z.string()),
              maps: z.array(z.string()),
              children: z.array(z.string()),
            })
            .optional(),
          // Revision 8 (#240): prior identities of a redefined unfinished frame, oldest first.
          redefinitions: z
            .array(
              z.object({
                workflow: z.object({ name: z.string().min(1), version: z.string().min(1) }),
                schemaDigest: z.string(),
                inputDigest: z.string(),
                redefinedAt: z.iso.datetime(),
              }),
            )
            .optional(),
          status: z.enum([
            'running',
            'completed',
            'failed',
            'cancelled',
            'suspended',
            'superseded',
          ]),
          startedAt: z.iso.datetime(),
          finishedAt: z.iso.datetime().nullable(),
          error: z.string().nullable(),
        })
        .refine(
          (frame) =>
            frame.settled === undefined ||
            (frame.onError === 'return' &&
              frame.finishedAt !== null &&
              frame.status === (frame.settled.outcome.ok ? 'completed' : 'failed') &&
              (frame.settled.outcome.ok || frame.settled.outcome.error.kind !== 'cancelled')),
          'A settled child frame needs onError return, a finish time, a matching status and a non-cancellation outcome.',
        ),
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
  // Not capped at the supported revision: a newer one must parse so it can be reported and refused.
  schemaRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  runBudget: runBudgetSchema.optional(),
  budgetStop: z
    .object({
      stepId: z.string(),
      metric: z.enum(['maxRunCostUsd', 'maxRunAgentAttempts', 'maxWindowUtilization']),
      limit: z.number().nonnegative(),
      observed: z.number().nonnegative(),
      at: z.iso.datetime(),
      harness: z.string().optional(),
      window: z.string().optional(),
      resetsAt: z.number().nonnegative().nullable().optional(),
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
          'wait.tolerated',
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
        // Revision 8 (#240): the inline child frame that ran the map.
        frame: z.string().optional(),
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
                  // Zero attempts marks an item cancelSiblings cancelled before it started.
                  error: stepErrorSchema.extend({
                    attempts: z.number().int().nonnegative(),
                    stepId: z.string().nullable(),
                  }),
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
        instructionSources: z.array(instructionSourceSchema).optional(),
      }),
    )
    .optional(),
  harnessWarnings: z.array(z.string()).optional(),
  projectInstructions: z
    .array(
      z.object({
        harness: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
        cwd: z.string(),
        sources: z.array(instructionSourceSchema),
      }),
    )
    .optional(),
  capabilities: capabilityManifestSchema.optional(),
  profileOverrides: z.array(profileOverrideSchema).optional(),
  grants: grantsSchema.optional(),
  grantedProfiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  policy: z.array(storedPolicyOverrideSchema).optional(),
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
  recoveryCause: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('grant'),
        profile: z.string(),
        access: z.string(),
        classOnly: z.literal(true).optional(),
      }),
      z.object({ kind: z.literal('divergence') }),
      z.object({ kind: z.literal('map-changed'), mapperOnly: z.boolean() }),
      z.object({ kind: z.literal('configuration') }),
      z.object({ kind: z.literal('budget'), flag: z.string() }),
      z.object({ kind: z.literal('authoring') }),
      z.object({ kind: z.literal('effect') }),
      z.object({ kind: z.literal('cancelled') }),
    ])
    .optional(),
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
          // Only a return map's own cancelSiblings cancellation is item data; an unstarted
          // item (zero attempts) is always such a cancellation with no originating step.
          (item.outcome?.ok === false &&
            item.outcome.error.attempts === 0 &&
            (item.outcome.error.kind !== 'cancelled' || item.outcome.error.stepId !== null)) ||
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

/** Most `projectInstructions` entries a run keeps; the oldest is dropped first. @internal */
export const MAX_PROJECT_INSTRUCTIONS = 128;

/**
 * The run's project instruction entries after recording `entry`: an existing entry for the same
 * harness and cwd is replaced (or, with `merge`, unioned with `entry`'s sources by kind and path,
 * the newer digest winning) and moves to the end, and the oldest entries beyond
 * {@link MAX_PROJECT_INSTRUCTIONS} are dropped. Returns a new array. @internal
 */
export function withProjectInstructions(
  entries: readonly ProjectInstructionsRecord[] | undefined,
  entry: ProjectInstructionsRecord,
  merge = false,
): ProjectInstructionsRecord[] {
  const same = (existing: ProjectInstructionsRecord): boolean =>
    existing.harness === entry.harness && existing.cwd === entry.cwd;
  const previous = merge ? entries?.find(same) : undefined;
  let recorded = entry;
  if (previous) {
    const byFile = new Map<string, InstructionSource>();
    for (const source of [...previous.sources, ...entry.sources])
      byFile.set(`${source.kind}\0${source.path}`, source);
    recorded = { ...entry, sources: [...byFile.values()] };
  }
  const kept = (entries ?? []).filter((existing) => !same(existing));
  kept.push(recorded);
  return kept.slice(-MAX_PROJECT_INSTRUCTIONS);
}

/**
 * The newest run-record schema revision this build reads and writes in full. Bump it, and add a
 * revision to `test/fixtures/schema-revision/record-keys.json`, whenever a persisted run-level
 * field is added or the accepted shape of one changes, including fields nested inside run-level
 * objects; see `docs/storage.md`. Revision 2 (#168) added `runBudget.maxWindowUtilization` and
 * the `maxWindowUtilization` budget stop with its `harness`, `window` and `resetsAt`. Revision 3
 * (#170) added the settled child frame's `onError` and `settled` fields to `children`. Revision 4
 * (#171) added the profile field `claude.addDirRoots` to `capabilities` and the optional `addDirs`
 * to step and attempt request summaries. Revision 5 (#223) added the run event type
 * `wait.tolerated` to `events`. Revision 6 (#226) added the top-level `projectInstructions` list of
 * per-cwd project instruction sources. Revision 7 (#227) changed only a nested shape: the
 * instruction source kind `claude-md`, in `harnesses` and `projectInstructions`. Revision 8 (#240)
 * changed only nested shapes: the child frame's `redefinitions` history in `children` and the
 * settled map's `frame` in `maps`. Revision 9 (#247) changed only a nested shape: the profile
 * field `redacted.harnesses` in `capabilities`, which holds digests of registered harness
 * `sensitiveOptions`. Revision 10 (#284) added the top-level `recoveryCause`, the typed cause
 * behind a failed run's recovery hint and `next` commands. Revision 11 (#289) changed only a
 * nested shape: the optional structured `issues` of a rejection in `question.rejections`.
 * Revision 12 (#300) changed only a nested shape: the step field `failureHistory` in `steps`.
 * @internal
 */
export const SUPPORTED_SCHEMA_REVISION = 12;

/**
 * Whether a run recorded any work: at least one step or settled map. A failed run without any gets
 * no recovery hint and no `next` commands, because there is nothing to reuse. @internal
 */
export function hasRecordedWork(record: Pick<RunRecord, 'steps' | 'maps'>): boolean {
  return Object.keys(record.steps).length > 0 || Object.keys(record.maps ?? {}).length > 0;
}

/** The top-level run-record keys this build knows. @internal */
export const RECORD_FIELD_KEYS: readonly string[] = Object.freeze(
  Object.keys(recordFieldsSchema.shape),
);
const recordFieldKeys = new Set(RECORD_FIELD_KEYS);

/** Whether a top-level run-record key is one this build knows. @internal */
export function isRecordFieldKey(key: string): boolean {
  return recordFieldKeys.has(key);
}

// Names, never values, of the top-level fields a read dropped, keyed by the exact record object
// that readRun returned. Values stay out of the record so no write can persist what this build
// does not understand; a clone or a re-read loses the entry, so check the object that was read.
const hiddenFields = new WeakMap<object, readonly string[]>();

/** Remember the top-level field names a read dropped from this record object. @internal */
export function markHiddenRecordFields(record: RunRecord, keys: Iterable<string>): void {
  const names = [...new Set(keys)].sort();
  if (names.length) hiddenFields.set(record, Object.freeze(names));
  else hiddenFields.delete(record);
}

/**
 * Top-level field names this build did not know in the stored record, sorted: those the read
 * dropped from this exact object, plus any unknown own keys it still carries (a custom store's
 * record). @internal
 */
export function hiddenRecordFields(record: RunRecord): readonly string[] {
  const own = Object.keys(record).filter((key) => !recordFieldKeys.has(key));
  const dropped = hiddenFields.get(record) ?? [];
  return own.length ? [...new Set([...dropped, ...own])].sort() : dropped;
}

/** Why this build must not rewrite a record: a newer schema revision, unknown fields, or both. @internal */
export interface RecordSchemaDrift {
  /** The record's revision; an absent field is revision 1. */
  readonly schemaRevision: number;
  /** {@link SUPPORTED_SCHEMA_REVISION} of this build. */
  readonly supportedSchemaRevision: number;
  /** Sorted top-level field names this build does not know. */
  readonly hiddenFields: readonly string[];
}

/** The schema drift of a record as read, or undefined when this build knows all of it. @internal */
export function recordSchemaDrift(record: RunRecord): RecordSchemaDrift | undefined {
  const schemaRevision = record.schemaRevision ?? 1;
  const hidden = hiddenRecordFields(record);
  return schemaRevision > SUPPORTED_SCHEMA_REVISION || hidden.length
    ? { schemaRevision, supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION, hiddenFields: hidden }
    : undefined;
}

/** At most this many hidden field names are listed in a refusal or warning. @internal */
export const maxListedHiddenFields = 10;

function listFields(fields: readonly string[]): string {
  const listed = fields.slice(0, maxListedHiddenFields).join(', ');
  const more = fields.length - maxListedHiddenFields;
  return more > 0 ? `${listed} and ${String(more)} more` : listed;
}

function driftReasons(drift: RecordSchemaDrift): string[] {
  return [
    ...(drift.schemaRevision > drift.supportedSchemaRevision
      ? [
          `was written by a newer quiet-choir (record schemaRevision ${String(drift.schemaRevision)}, this build supports ${String(drift.supportedSchemaRevision)})`,
        ]
      : []),
    ...(drift.hiddenFields.length
      ? [`has fields this build does not know: ${listFields(drift.hiddenFields)}`]
      : []),
  ];
}

/** The refusal for a write to a record this build cannot fully read. @internal */
export function recordSchemaRefusalMessage(runId: string, drift: RecordSchemaDrift): string {
  return `Run ${runId} ${driftReasons(drift).join(' and ')}. Upgrade quiet-choir to resume or rewrite it; nothing was changed.`;
}

/** The read-path warning for a record this build cannot fully read. @internal */
export function recordSchemaWarning(drift: RecordSchemaDrift): string {
  return `This run record ${driftReasons(drift).join(' and ')}; this view omits what this build does not know, and resume, check-resume, tick, fork and clean refuse the run until quiet-choir is upgraded.`;
}

/** `run.incompatible` with `reason: 'record_schema'` for a record this build must not rewrite. @internal */
export function recordSchemaRefusal(
  runId: string,
  drift: RecordSchemaDrift,
  cause?: unknown,
): RunRefusedError {
  return new RunRefusedError(
    'run.incompatible',
    runId,
    recordSchemaRefusalMessage(runId, drift),
    {
      reason: 'record_schema',
      schemaRevision: drift.schemaRevision,
      supportedSchemaRevision: drift.supportedSchemaRevision,
      hiddenFields: [...drift.hiddenFields],
    },
    cause === undefined ? undefined : { cause },
  );
}

/** Throw the record-schema refusal when this build must not rewrite the record as read. @internal */
export function refuseRecordSchemaDrift(record: RunRecord): void {
  const drift = recordSchemaDrift(record);
  if (drift) throw recordSchemaRefusal(record.id, drift);
}

/** A raw schemaRevision newer than this build's, when the raw value is one. @internal */
export function newerSchemaRevision(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > SUPPORTED_SCHEMA_REVISION
    ? value
    : undefined;
}

/** Validate bytes from an atomic checkpoint read, including synchronous interrupt reporting. @internal */
export function parseRunRecord(text: string, runId: string): RunRecord {
  const raw = jsonValue(JSON.parse(text));
  const fields = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(fields).filter((key) => !recordFieldKeys.has(key));
  let record: RunRecord;
  try {
    record = recordSchema.parse(raw) as RunRecord;
  } catch (cause) {
    // A newer build may have changed the shape of a field this build knows, with or without
    // bumping the revision; unknown fields are drift on their own. Without either it is corruption.
    const newer = newerSchemaRevision(Reflect.get(fields, 'schemaRevision'));
    if (newer === undefined && unknown.length === 0) throw cause;
    throw recordSchemaRefusal(
      runId,
      {
        schemaRevision: newer ?? SUPPORTED_SCHEMA_REVISION,
        supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
        hiddenFields: unknown.sort(),
      },
      cause,
    );
  }
  if (record.id !== runId) throw new Error('Checkpoint run ID does not match its filename.');
  markHiddenRecordFields(record, unknown);
  return normalizeStoredHarnesses(record);
}

/**
 * Normalize read views only (legacy harness names, and the pre-#341 Codex reasoningEffort as effort
 * in attempts, saved policy and capability manifests); original checkpoint bytes and native
 * identity digests remain untouched. Runs after the snapshot parse and after journal replay.
 * @internal
 */
export function normalizeStoredHarnesses(record: RunRecord): RunRecord {
  const summary = (value: RequestSummary | null | undefined): void => {
    if (!value) return;
    const legacy: unknown = Reflect.get(value, 'provider');
    if (!Object.hasOwn(value, 'harness') && typeof legacy === 'string')
      Object.assign(value, { harness: legacy });
    Reflect.deleteProperty(value, 'provider');
  };
  // Codex reasoningEffort was renamed to effort (#341); validation rejects a value holding both.
  const effort = (value: unknown, where: string): void => {
    if (!renameLegacyEffort(value))
      throw new Error(`${where} has both effort and legacy reasoningEffort.`);
  };
  for (const [id, step] of Object.entries(record.steps)) {
    if (record.formatVersion !== 1 && (step.kind === 'claude' || step.kind === 'codex')) {
      step.harness = step.kind;
      step.revision = 1;
      step.kind = 'agent';
    }
    summary(step.request);
    for (const attempt of step.attemptHistory ?? []) {
      summary(attempt.request);
      effort(attempt, `Step ${id} attempt ${String(attempt.attempt)}`);
    }
  }
  (record.policy ?? []).forEach((rule, index) => {
    effort(rule, `Saved policy rule ${String(index)}`);
  });
  if (record.capabilities) {
    effort(record.capabilities.defaults.codex, 'Capability defaults codex');
    for (const [name, profile] of Object.entries(record.capabilities.profiles))
      effort(profile.codex, `Capability profile ${name} codex`);
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
  // A settled child frame replays its outcome without running the effects it owned.
  for (const frame of Object.values(record.children ?? {})) {
    for (const id of frame.settled?.steps ?? []) steps.add(id);
    for (const id of frame.settled?.maps ?? []) maps.add(id);
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
