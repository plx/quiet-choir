import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { resolveStateDir, type StateDirectoryOptions } from './paths.js';
import { jsonValue } from './json.js';
import type { AgentUsage, JsonValue } from './model.js';
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
  status: 'running' | 'completed' | 'failed';
  /** Failure message, when available. */
  error: string | null;
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
  /** Hash of explicit dependencies and output schema. */
  fingerprint: string;
  /** Last saved lifecycle state. */
  status: 'running' | 'completed' | 'failed' | 'superseded';
  /** Semantic component hashes; absent in version 1 checkpoints. */
  identity?: StepIdentity;
  /** Prior identities of unfinished effects. */
  redefinitions?: StepRedefinition[];
  /** Per-attempt execution limits, provenance, and outcome. */
  attemptHistory?: AttemptRecord[];
  /** First-use ordering within this run; present in format 3. */
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

/** Local checkpoint format. The format is intentionally versioned independently of workflows. */
export interface RunRecord {
  /** Checkpoint format version. */
  formatVersion: 1 | 2 | 3;
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
    /** Component hashes and engine compatibility, present in format 3. */
    identity?: WorkflowIdentity;
  };
  /** Absolute working directory, fixed across resumes. */
  cwd: string;
  /** Validated original workflow input. */
  input: JsonValue;
  /** Validated final output, or null before completion. */
  output: JsonValue;
  /** Run lifecycle status. */
  status: 'running' | 'completed' | 'failed';
  /** Last workflow error, if any. */
  error: string | null;
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
  /** Guidance when all recorded effects completed before a tail/output failure. */
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
  status: z.enum(['running', 'completed', 'failed', 'superseded']),
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
        status: z.enum(['running', 'completed', 'failed']),
        error: z.string().nullable(),
        policy: executionPolicySchema.extend({
          retry: z.object({
            maxAttempts: z.number().int().positive(),
            delayMs: z.number().nonnegative(),
          }),
        }),
        sources: z.record(z.string(), z.string()),
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
    formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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
    status: z.enum(['running', 'completed', 'failed']),
    error: z.string().nullable(),
    steps: stepsSchema,
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
    if (record.policy === undefined || record.allowModelOverride === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint is missing execution policy metadata',
      });
    if (record.formatVersion === 3 && record.workflow.identity === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Version 3 checkpoint is missing workflow identity',
      });
    const sequences = new Set<number>();
    for (const [id, step] of Object.entries(record.steps)) {
      if (record.formatVersion === 3) {
        if (step.seq === undefined || sequences.has(step.seq))
          context.addIssue({
            code: 'custom',
            path: ['steps', id, 'seq'],
            message: 'Version 3 steps require unique positive seq values',
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
      const current = ownerSchema.parse(
        JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
      );
      if (current.token !== owner.token) throw new Error(`Run ${runId} lock ownership was lost.`);
      await rm(lockPath, { recursive: true });
    };
  }
  throw new Error(`Could not acquire run ${runId}; retry after competing writers finish.`);
}
