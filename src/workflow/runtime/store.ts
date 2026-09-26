import { profileOverrideSchema, grantsSchema, capabilityManifestSchema } from './profiles.js';
import type { CapabilityManifest, ProfileOverride } from './profiles-model.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { resolveStateDir, type StateDirectoryOptions } from './paths.js';
import { jsonValue } from './json.js';
import { errorKindSchema, stepErrorSchema } from './step-error.js';
import type { AgentUsage, ErrorKind, JsonValue, Settled, StepError } from './model.js';
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
  /** Total attempt number across resumes. */
  readonly attempt: number;
  /** Identity fingerprint for this version of the effect. */
  readonly fingerprint: string;
  /** ISO timestamp saved before the effect starts. */
  readonly startedAt: string;
  /** ISO timestamp after settlement, or null for an interrupted attempt. */
  finishedAt: string | null;
  /** Last observed outcome; running may indicate an interrupted process. */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
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
  /** Effect category; included in replay compatibility checks. */
  kind: 'step' | 'claude' | 'codex' | 'sleep';
  /** Hash of semantic components, including error mode. */
  fingerprint: string;
  /** Last saved lifecycle state. */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'settled-failed' | 'superseded';
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
  /** Running items are retried; completed items replay the entire saved outcome. */
  status: 'running' | 'completed';
  /** Serialized mapper result/failure, or null until committed. */
  outcome: Settled<JsonValue, MapStepError> | null;
  /** Owned leaf IDs, including failed children whose outcome this item contains. */
  steps: string[];
  /** Owned nested map journal IDs. */
  maps: string[];
}

/** Journal for an explicitly identified settled map. */
export interface MapRecord {
  /** Hash of item inputs, mapper source, optional version and cwd. */
  fingerprint: string;
  /** First-use ordering shared with step seq values; absent in journals saved before it existed. */
  seq?: number;
  /** Partially evaluated or completely settled collection. */
  status: 'running' | 'completed';
  /** Item journals in input order. */
  items: MapItemRecord[];
}

/** Local checkpoint format. The format is intentionally versioned independently of workflows. */
export interface RunRecord {
  /** Resolved declared capabilities at the latest execution. Absent in older format-5 records. */
  capabilities?: CapabilityManifest;
  /** Sticky profile limit rules. */
  profileOverrides?: ProfileOverride[];
  /** Persisted operator grants; forks require their own grants. */
  grants?: string[];
  /** Capability digests pinning profile-name grants against source edits. */
  grantedProfiles?: Record<string, string>;
  /** Checkpoint format version. */
  formatVersion: 1 | 2 | 3 | 4 | 5;
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
  status: 'running' | 'completed' | 'failed' | 'cancelled';
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
  /** Guidance when all recorded effects reached terminal outcomes before a tail/output failure. */
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
const stepSchema = z.object({
  kind: z.enum(['step', 'claude', 'codex', 'sleep']),
  seq: z.number().int().positive().optional(),
  reusedFrom: reusedStepSchema.optional(),
  fingerprint: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'settled-failed', 'superseded']),
  cancelledBy: z.string().nullable().optional(),
  settledError: stepErrorSchema.optional(),
  identity: z.record(z.string(), z.string()).optional(),
  redefinitions: z
    .array(
      z.object({
        fingerprint: z.string(),
        identity: z.record(z.string(), z.string()),
        redefinedAt: z.iso.datetime(),
      }),
    )
    .optional(),
  attemptHistory: z
    .array(
      z.object({
        attempt: z.number().int().positive(),
        fingerprint: z.string(),
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime().nullable(),
        status: z.enum(['running', 'completed', 'failed', 'cancelled']),
        error: z.string().nullable(),
        errorKind: errorKindSchema.optional(),
        policy: executionPolicySchema.extend({
          retry: z.object({
            maxAttempts: z.number().int().positive(),
            delayMs: z.number().nonnegative(),
            on: z.array(errorKindSchema).optional(),
          }),
        }),
        sources: z.record(z.string(), z.string()),
        profile: z.string().optional(),
        requestedModel: z.string().nullable(),
        reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).nullable(),
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
});
const stepsSchema = z.custom<Record<string, StepRecord>>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((step) => stepSchema.safeParse(step).success),
);
const recordSchema = z
  .object({
    formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
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
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    error: z.string().nullable(),
    steps: stepsSchema,
    rootCause: z.object({ stepId: z.string().nullable(), error: z.string() }).nullable().optional(),
    maps: z
      .record(
        z.string(),
        z.object({
          fingerprint: z.string(),
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
            }),
          ),
        }),
      )
      .optional(),
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
        }),
      )
      .optional(),
    replayWarnings: z.array(z.string()).optional(),
    recoveryHint: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    if (record.formatVersion === 1) return;
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

function pathFor(stateDir: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error(
      'Run ID must be 1–128 letters, numbers, underscores, or hyphens, starting with a letter or number.',
    );
  }
  return join(resolve(stateDir), `${runId}.json`);
}

/** Locate a run using the same cwd and stateDir defaults as runWorkflow. */
export interface ReadRunOptions extends StateDirectoryOptions {
  /** Stable identifier of the saved run. */
  readonly runId: string;
}

/** Read and validate a run without acquiring a writer lock; missing files retain code ENOENT. */
export async function readRun(options: ReadRunOptions): Promise<RunRecord> {
  const { runId } = options;
  const stateDir = resolveStateDir(options);
  const raw = jsonValue(JSON.parse(await readFile(pathFor(stateDir, runId), 'utf8')));
  const record = recordSchema.parse(raw);
  if (record.id !== runId) throw new Error('Checkpoint run ID does not match its filename.');
  return record as RunRecord;
}

/** Atomically replace a checkpoint after flushing its content to local disk. @internal */
export async function writeRun(stateDir: string, record: RunRecord): Promise<void> {
  const path = pathFor(stateDir, record.id);
  const content = jsonValue(record);
  recordSchema.parse(content);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(content, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    // Flush the directory entry too; local POSIX filesystems are the durability target.
    const directory = await open(resolve(stateDir), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  token: z.string(),
});

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function lockGone(lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
    return false;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

/** Acquire a single local writer, recovering a dead local owner conservatively. @internal */
export async function lockRun(stateDir: string, runId: string): Promise<() => Promise<void>> {
  const lockPath = `${pathFor(stateDir, runId)}.lock`;
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      let previous;
      try {
        previous = ownerSchema.parse(
          JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
        );
      } catch (cause) {
        throw new Error(
          `Run ${runId} is locked with incomplete ownership metadata; inspect ${lockPath} before removing an abandoned lock.`,
          { cause },
        );
      }
      if (previous.host !== hostname() || !isDead(previous.pid))
        throw new Error(
          `Run ${runId} is locked by PID ${String(previous.pid)} on ${previous.host}.`,
          { cause: error },
        );
      // Only one contender may remove a dead owner's lock. Recheck ownership after winning recovery.
      const recovery = join(lockPath, 'recovery');
      try {
        await mkdir(recovery);
      } catch (cause) {
        throw new Error(
          `Run ${runId} lock recovery is in progress; retry or inspect ${lockPath}.`,
          { cause },
        );
      }
      const current = ownerSchema.parse(
        JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
      );
      if (current.token !== previous.token || !isDead(current.pid)) {
        await rm(recovery, { recursive: true, force: true });
        throw new Error(`Run ${runId} lock ownership changed during recovery; retry.`, {
          cause: error,
        });
      }
      await rm(lockPath, { recursive: true });
      continue;
    }
    try {
      await using file = await open(join(lockPath, 'owner.json'), 'wx', 0o600);
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
      // Only this run's lock owner can remove abandoned atomic-write files.
      const prefix = `${runId}.json.`;
      for (const entry of await readdir(resolve(stateDir), { withFileTypes: true })) {
        if (
          entry.isFile() &&
          entry.name.startsWith(prefix) &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(
            entry.name.slice(prefix.length),
          )
        )
          await rm(join(resolve(stateDir), entry.name), { force: true });
      }
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      let current;
      try {
        current = ownerSchema.parse(
          JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
        );
      } catch (cause) {
        // A vanished lock keeps its errno; missing or unreadable metadata in a present lock does not,
        // so callers cannot mistake unverified ownership for a cleanup-only failure.
        if (isErrno(cause, 'ENOENT') && (await lockGone(lockPath))) throw cause;
        throw new Error(`Run ${runId} lock ownership could not be verified; inspect ${lockPath}.`, {
          cause,
        });
      }
      if (current.token !== owner.token) throw new Error(`Run ${runId} lock ownership was lost.`);
      await rm(lockPath, { recursive: true });
    };
  }
  throw new Error(`Could not acquire run ${runId}; retry after competing writers finish.`);
}

/** An outcome already observed by the workflow that must be preserved on replay. @internal */
export function isTerminalStep(step: StepRecord): boolean {
  return step.status === 'completed' || step.status === 'settled-failed';
}

/** Whether all recorded work can replay without executing an unfinished item/effect. @internal */
export function hasTerminalOutcomes(record: RunRecord): boolean {
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
