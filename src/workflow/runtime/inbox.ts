import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonValue, digest } from './json.js';
import { validateStepId } from './identity.js';
import { resolveStateDir, type StateDirectoryOptions } from './paths.js';
import { readRun, type RunRecord } from './store.js';
import { isValidRunId, runIdMessage } from './run-errors.js';
import { answerEnvelopeSchema, validateAnswerAuthor } from './question-schema.js';
import type { JsonValue } from './model.js';
import type { PendingQuestion } from './question-model.js';

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

/** Portable inbox name, retaining readable IDs when they fit the filesystem limit. @internal */
export function answerPath(stateDir: string, runId: string, stepId: string): string {
  if (!isValidRunId(runId)) throw new Error(runIdMessage);
  validateStepId(stepId);
  const encoded = encodeURIComponent(stepId);
  const filename = encoded.length <= 180 ? encoded : `~sha256-${digest(stepId)}`;
  return join(stateDir, `${runId}.inbox`, `${filename}.answer.json`);
}

/** Write one exclusive, fsynced inbox delivery without acquiring the run lock or importing code. */
export async function writeAnswer(options: WriteAnswerOptions): Promise<AnswerDelivery> {
  const stateDir = resolveStateDir(options);
  const run = await readRun({ ...options, stateDir });
  const step = Object.hasOwn(run.steps, options.stepId) ? run.steps[options.stepId] : undefined;
  if (step?.kind !== 'ask' || step.status !== 'waiting' || !step.question)
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
  const directory = join(stateDir, `${run.id}.inbox`);
  const path = answerPath(stateDir, run.id, options.stepId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
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

/** Render waiting questions from one already-read checkpoint. @internal */
export async function pendingQuestions(
  run: RunRecord,
  stateDir: string,
): Promise<PendingQuestion[]> {
  const codeChanged = await questionCodeChanged(run);
  return Object.entries(run.steps).flatMap(([stepId, step]) =>
    step.kind === 'ask' && step.status === 'waiting' && step.question
      ? [
          {
            ...structuredClone(step.question.request),
            runId: run.id,
            stepId,
            questionFingerprint: step.fingerprint,
            askedAt: step.question.askedAt,
            rejections: structuredClone(step.question.rejections),
            codeChanged,
            answerCommand: [
              'quiet-choir',
              'workflow',
              'answer',
              run.id,
              stepId,
              '--state-dir',
              stateDir,
              '--json',
              '<ANSWER_JSON>',
            ],
          },
        ]
      : [],
  );
}

/** List every waiting question by reading checkpoints and source bytes only; never imports code. */
export async function listPending(options: StateDirectoryOptions = {}): Promise<PendingQuestion[]> {
  const stateDir = resolveStateDir(options);
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const pending: PendingQuestion[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json') || !isValidRunId(file.slice(0, -5))) continue;
    const run = await readRun({ stateDir, runId: file.slice(0, -5) });
    pending.push(...(await pendingQuestions(run, stateDir)));
  }
  return pending;
}
