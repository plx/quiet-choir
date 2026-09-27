import { createStorageDirectory, syncDirectory } from './storage-io.js';
import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { jsonValue, digest } from './json.js';
import { validateStepId } from './identity.js';
import {
  resolveStateDir,
  runInboxPath,
  runDirectory,
  type StateDirectoryOptions,
} from './paths.js';
import { readRun, listRunIds, type RunRecord } from './store.js';
import { isValidRunId, runIdMessage } from './run-errors.js';
import { answerEnvelopeSchema, validateAnswerAuthor } from './question-schema.js';
import type { JsonValue } from './model.js';
import type { PendingOperation } from './wait-model.js';

/** A rejected delivery: invalid input is exit 2, a closed/already answered question is exit 3. */
export class AnswerError extends Error {
  /** Distinguishes validation from first-answer or lifecycle conflicts. */
  public readonly reason: 'invalid' | 'conflict';
  public constructor(reason: 'invalid' | 'conflict', message: string) {
    super(message);
    this.name = 'AnswerError';
    this.reason = reason;
  }
}

/** A lock-free delivery to a question already present in a checkpoint. */
export interface WriteAnswerOptions extends StateDirectoryOptions {
  /** Existing run ID. */
  readonly runId: string;
  /** Fully qualified question step ID. */
  readonly stepId: string;
  /** Untrusted JSON answer, checked against the stored schema before writing. */
  readonly value: unknown;
  /** Self-asserted attribution; defaults to agent:unspecified. */
  readonly by?: string;
}

/** A delivery was queued; only owner ingestion authoritatively accepts the answer. */
export interface AnswerDelivery {
  /** Owning run. */
  readonly runId: string;
  /** Question ID. */
  readonly stepId: string;
  /** Absolute audit file path. */
  readonly path: string;
  /** Question contract matched by this delivery. */
  readonly questionFingerprint: string;
}

/** Format-6 answer name, still the final path in a migrated run's flat inbox. */
function legacyAnswerName(stepId: string): string {
  const encoded = encodeURIComponent(stepId);
  return `${encoded.length <= 180 ? encoded : `~sha256-${digest(stepId)}`}.answer.json`;
}

/** Format-7 answer name: a readable prefix plus a digest that keeps case variants distinct. */
function currentAnswerName(stepId: string): string {
  return `${encodeURIComponent(stepId).slice(0, 100)}--${digest(stepId)}.answer.json`;
}

/**
 * Portable inbox name, retaining readable IDs when they fit the filesystem limit. A flat
 * `<runId>.inbox` keeps the format-6 name so pre-upgrade and current writers race on one link.
 * @internal
 */
export function answerPath(stateDir: string, runId: string, stepId: string): string {
  if (!isValidRunId(runId)) throw new Error(runIdMessage);
  validateStepId(stepId);
  const inbox = runInboxPath(stateDir, runId);
  const flat = inbox === `${runDirectory(stateDir, runId)}.inbox`;
  return join(inbox, flat ? legacyAnswerName(stepId) : currentAnswerName(stepId));
}

/** Current and pre-migration answer names in both inbox layouts; none is left unconsumed. @internal */
export function answerCandidates(stateDir: string, runId: string, stepId: string): string[] {
  const legacy = legacyAnswerName(stepId);
  const current = currentAnswerName(stepId);
  const path = answerPath(stateDir, runId, stepId);
  const inboxes = [
    join(runDirectory(stateDir, runId), 'inbox'),
    `${runDirectory(stateDir, runId)}.inbox`,
  ];
  return [
    ...new Set([
      path,
      ...inboxes.map((inbox) => join(inbox, current)),
      ...inboxes.map((inbox) => join(inbox, legacy)),
    ]),
  ];
}

/** Write one exclusive, fsynced inbox delivery without acquiring the run lock or importing code. */
export async function writeAnswer(options: WriteAnswerOptions): Promise<AnswerDelivery> {
  const stateDir = resolveStateDir(options);
  const run = await readRun({ ...options, stateDir });
  const step = Object.hasOwn(run.steps, options.stepId) ? run.steps[options.stepId] : undefined;
  if (!step || !['ask', 'wait'].includes(step.kind) || step.status !== 'waiting' || !step.question)
    throw new AnswerError(
      'conflict',
      `Question ${options.stepId} is not waiting in run ${run.id}.`,
    );
  let value: JsonValue;
  const by = options.by ?? 'agent:unspecified';
  try {
    value = jsonValue(options.value, 'Answer');
    const schema = step.question.request.schema;
    if (
      typeof schema !== 'boolean' &&
      (schema === null || Array.isArray(schema) || typeof schema !== 'object')
    )
      throw new Error('Stored question schema is not a JSON Schema object.');
    z.fromJSONSchema(schema).parse(value);
    validateAnswerAuthor(step.question.request.audience, by);
    answerEnvelopeSchema.parse({
      value,
      by,
      at: new Date().toISOString(),
      questionFingerprint: step.fingerprint,
    });
  } catch (error) {
    throw new AnswerError('invalid', error instanceof Error ? error.message : String(error));
  }
  const serialized = JSON.stringify({
    value,
    by,
    at: new Date().toISOString(),
    questionFingerprint: step.fingerprint,
  });
  if (Buffer.byteLength(serialized) > 1_048_576)
    throw new AnswerError('invalid', 'Answer envelope exceeds 1 MiB.');
  const path = answerPath(stateDir, run.id, options.stepId);
  for (const candidate of answerCandidates(stateDir, run.id, options.stepId)) {
    if (candidate === path) continue;
    const existing = await stat(candidate).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing)
      throw new AnswerError(
        'conflict',
        `Question ${options.stepId} already has a legacy inbox delivery.`,
      );
  }
  const directory = dirname(path);
  await createStorageDirectory(directory);
  const temporary = join(directory, `.answer-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      await syncDirectory(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new AnswerError(
          'conflict',
          `Question ${options.stepId} already has an inbox delivery.`,
        );
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { runId: run.id, stepId: options.stepId, path, questionFingerprint: step.fingerprint };
}

/** Determine source drift from saved paths and bytes, without typechecking or importing. @internal */
export async function questionCodeChanged(run: RunRecord): Promise<boolean | null> {
  if (!run.launch?.sources) return null;
  for (const [path, hash] of Object.entries(run.launch.sources)) {
    try {
      if (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== hash
      )
        return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Render parked operations from a checkpoint without loading workflow code. @internal */
export async function pendingOperations(
  run: RunRecord,
  stateDir: string,
): Promise<PendingOperation[]> {
  const codeChanged = await questionCodeChanged(run);
  const pending: PendingOperation[] = [];
  for (const [stepId, step] of Object.entries(run.steps)) {
    if (step.status !== 'waiting') continue;
    const answerCommand = step.question
      ? [
          'quiet-choir',
          'workflow',
          'answer',
          run.id,
          stepId,
          '--state-dir',
          stateDir,
          '--json',
          '<ANSWER_JSON>',
        ]
      : null;
    if (step.kind === 'wait' && step.wait) {
      pending.push({
        kind: 'wait',
        runId: run.id,
        stepId,
        openedAt: step.wait.openedAt,
        deadline: step.wait.deadline,
        nextCheckAt: step.wait.nextCheckAt,
        checks: step.wait.checks,
        note: structuredClone(step.wait.note),
        signal: step.question ? structuredClone(step.question.request) : null,
        rejections: structuredClone(step.question?.rejections ?? []),
        codeChanged,
        answerCommand,
      });
    } else if (step.kind === 'ask' && step.question) {
      pending.push({
        ...structuredClone(step.question.request),
        runId: run.id,
        stepId,
        questionFingerprint: step.fingerprint,
        askedAt: step.question.askedAt,
        rejections: structuredClone(step.question.rejections),
        codeChanged,
        answerCommand,
      });
    }
  }
  return pending;
}

/** List parked questions, polls, and deadlines by reading state only; never imports code. */
export async function listPending(
  options: StateDirectoryOptions = {},
): Promise<PendingOperation[]> {
  const stateDir = resolveStateDir(options);
  const pending: PendingOperation[] = [];
  for (const runId of await listRunIds(stateDir)) {
    const run = await readRun({ stateDir, runId });
    pending.push(...(await pendingOperations(run, stateDir)));
  }
  return pending;
}
