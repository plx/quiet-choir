import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { jsonValue } from './json.js';
import type { AgentUsage, JsonValue } from './model.js';

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
  status: 'running' | 'completed' | 'failed';
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
  formatVersion: 1;
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
const stepSchema = z.object({
  kind: z.enum(['step', 'claude', 'codex', 'sleep']),
  fingerprint: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
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
const recordSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string(),
  workflow: z.object({ name: z.string(), version: z.string(), fingerprint: z.string().nullable() }),
  cwd: z.string(),
  input: jsonSchema,
  output: jsonSchema,
  status: z.enum(['running', 'completed', 'failed']),
  error: z.string().nullable(),
  steps: stepsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function pathFor(stateDir: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error(
      'Run ID must be 1–128 letters, numbers, underscores, or hyphens, starting with a letter or number.',
    );
  }
  return join(resolve(stateDir), `${runId}.json`);
}

/** Read and validate a run without acquiring a writer lock. */
export async function readRun(stateDir: string, runId: string): Promise<RunRecord> {
  const raw = jsonValue(JSON.parse(await readFile(pathFor(stateDir, runId), 'utf8')));
  const record = recordSchema.parse(raw);
  if (record.id !== runId) throw new Error('Checkpoint run ID does not match its filename.');
  return record;
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
