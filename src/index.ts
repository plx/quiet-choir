/**
 * Typed external agent workflows with local durable checkpoints.
 *
 * @packageDocumentation
 */
export { z } from 'zod';
export { defineWorkflow } from './workflow/runtime/model.js';
export { HarnessError } from './workflow/runtime/harness-error.js';
export type {
  HarnessExit,
  HarnessErrorDetails,
  ProtocolFailure,
} from './workflow/runtime/harness-error.js';
export type {
  JsonValue,
  JsonInput,
  ErrorKind,
  ErrorMode,
  StepError,
  Settled,
  SettledMapOptions,
  MapOptions,
  SettledNamedMapOptions,
  EffectResult,
  Effort,
  HarnessMetadata,
  ImageAttachment,
  AgentOptions,
  ClaudeOptions,
  CodexOptions,
  HarnessRequest,
  HarnessRequestInput,
  HarnessCall,
  HarnessInvocation,
  HarnessProcess,
  AgentUsage,
  HarnessResponse,
  Harness,
  AgentResult,
  AgentClient,
  RetryPolicy,
  StepContext,
  StepDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from './workflow/runtime/model.js';
export { CheckpointError } from './workflow/runtime/checkpoint.js';
export { ConfigurationError } from './workflow/runtime/configuration-error.js';
export { runWorkflow, assertCompleted } from './workflow/runtime/runner.js';
export type {
  WorkflowEvent,
  WorkflowRun,
  WorkflowResult,
  SuspendedRun,
  RunOptions,
} from './workflow/runtime/runner.js';
export { readRun, inspectRunOwnership } from './workflow/runtime/store.js';
export type {
  RunRecord,
  RunOwnership,
  MapRecord,
  MapItemRecord,
  StepRecord,
  FailedAttempt,
  AttemptRecord,
  StepRedefinition,
  ReadRunOptions,
} from './workflow/runtime/store.js';
export { CliHarness } from './harnesses/cli.js';
export { checkCodexSchema } from './harnesses/codex-schema.js';
export type { SchemaIssue } from './harnesses/codex-schema.js';
export type { CliPlanArtifact, CliArgumentPlan } from './harnesses/invocation.js';
export type { CliHarnessOptions, CliHarnessPlan } from './harnesses/cli.js';

export { claudeOptionsSchema, codexOptionsSchema } from './workflow/runtime/options.js';

export { resolveStateDir } from './workflow/runtime/paths.js';
export type { StateDirectoryOptions } from './workflow/runtime/paths.js';
export type { ExecutionPolicy, PolicyOverride, AttemptPolicy } from './workflow/runtime/policy.js';
export type { StepIdentity } from './workflow/runtime/identity.js';

export { checkResume } from './workflow/runtime/compatibility.js';
export type { CheckResumeOptions, WorkflowCodeOptions } from './workflow/runtime/compatibility.js';
export type {
  EngineInfo,
  SourceFingerprint,
  WorkflowIdentity,
  ForkOptions,
  ForkProvenance,
  ReusedStep,
  CodeChange,
  ResumeCheck,
} from './workflow/runtime/replay-model.js';

export { CancelledError, FanOutError } from './workflow/runtime/fan-out.js';
export type { FanOutFailure, MapStepError, RootCause } from './workflow/runtime/fan-out.js';

export { stepId } from './workflow/runtime/identity.js';

export { capabilityManifest } from './workflow/runtime/profiles.js';
export type {
  BuiltinProfile,
  AccessClass,
  ProfileLimits,
  AgentProfile,
  AgentDefaults,
  ProfileOverride,
  ResolvedProfile,
  CapabilityManifest,
} from './workflow/runtime/profiles-model.js';

export { probeHarnessContracts, testedHarnessVersions } from './harnesses/doctor.js';
export type { DoctorOptions, DoctorReport, DoctorCheck } from './harnesses/doctor.js';
export { readInheritedCodexConfig } from './harnesses/doctor-config.js';
export type { InheritedCodexConfig } from './harnesses/doctor-config.js';

export { createAgentLimiter, defaultAgentLimits } from './workflow/runtime/agent-limiter.js';
export type {
  AgentLimits,
  AgentPermit,
  AgentLimiter,
  AgentLimiterSnapshot,
} from './workflow/runtime/agent-limiter.js';

export { ProcessSupervisor } from './processes/supervisor.js';
export { OrphanProcessesError } from './workflow/runtime/process-registry.js';
export type {
  HarnessProcessRecord,
  HarnessProcessInspection,
} from './workflow/runtime/process-registry.js';

export {
  WorkflowRunError,
  WorkflowInputError,
  RunRefusedError,
  isValidRunId,
} from './workflow/runtime/run-errors.js';
export type { CliErrorCode } from './workflow/runtime/run-errors.js';

export type {
  PhaseOptions,
  PhaseInfo,
  RequestSummary,
  ExecutionRecord,
  RunEvent,
  UsageSummary,
} from './workflow/runtime/observability-model.js';

export { FixtureHarness, parseHarnessFixtures } from './harnesses/fixture.js';
export type { FixtureCall, HarnessFixtures } from './harnesses/fixture.js';
export { synthesizeOutput } from './harnesses/synthesize.js';

export type {
  AskOptions,
  ApproveOptions,
  Approval,
  QuestionChoice,
  QuestionRequest,
  QuestionRecord,
  QuestionResolution,
  QuestionRejection,
  PendingQuestion,
  WorkflowLaunch,
} from './workflow/runtime/question-model.js';
export { writeAnswer, listPending, AnswerError } from './workflow/runtime/inbox.js';
export type { WriteAnswerOptions, AnswerDelivery } from './workflow/runtime/inbox.js';

export { FileRunStore } from './workflow/runtime/run-store.js';
export type { RunStore, OwnedRunStore, RunStoreOpenOptions } from './workflow/runtime/run-store.js';

export type {
  WorkflowClock,
  SignalSource,
  PollInterval,
  PollSource,
  WaitSources,
  WaitOutcome,
  SignalOutcome,
  PollOutcome,
  DeadlineOutcome,
  PollOptions,
  PollRequest,
  WaitRequest,
  WaitRecord,
  PendingWait,
  PendingOperation,
} from './workflow/runtime/wait-model.js';

export { NodeProcessRunner } from './processes/runner.js';
export { ExecError } from './workflow/runtime/exec-error.js';
export type {
  Command,
  ExecOptions,
  ExecResult,
  ExecFunction,
  ProcessRunRequest,
  ProcessRunner,
  ExecSummary,
  ExecDiagnostics,
} from './workflow/runtime/exec-model.js';

export type {
  ReadFileOptions,
  ReadFileResult,
  WriteFileOptions,
  WriteFileResult,
} from './workflow/runtime/file-model.js';

export { guardFile } from './workflow/helpers/guard-file.js';
export type { GuardFileOptions } from './workflow/helpers/guard-file.js';

export type {
  WorktreeBase,
  WorktreeHandle,
  WorktreeIsolation,
  WorktreeChange,
  WorktreeCreateOptions,
  WorktreeSetupContext,
  WorktreePolicy,
  MergeOptions,
  MergeResult,
} from './workflow/runtime/worktree-model.js';

export type {
  HarnessIsolation,
  AgentIsolation,
  AgentWorktree,
} from './workflow/runtime/agent-isolation.js';
export type {
  AgentEnvironment,
  EnvironmentEdits,
  EnvironmentSummary,
  HostEnvironmentSummary,
} from './workflow/runtime/agent-environment-model.js';
export type { ScrubEnvironment } from './harnesses/environment.js';

export type {
  WorktreeStep,
  WorktreeLedger,
  MergePreparation,
} from './workflow/runtime/worktree-schema.js';
