import { brandError, isBranded } from './error-brand.js';
import { createStorageDirectory, syncDirectory, syncHandle } from './storage-io.js';
import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, rm, rmdir, stat } from 'node:fs/promises';
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
import type { PendingDelivery, PendingListing, PendingOperation } from './wait-model.js';
import { workflowArgv, type CommandLauncher } from './commands.js';

/**
 * One reason an answer was refused as invalid. Zod issues are normalized to this shape so the
 * contract does not depend on Zod internals; a refusal that has no schema path uses a synthetic
 * `code` (`answer_not_json`, `question_schema_invalid`, `answer_author`, `answer_too_large`) and a
 * path of `[]`.
 */
export interface AnswerIssue {
  /** Zod issue code, or one of the synthetic codes named above. */
  readonly code: string;
  /** Location in the answer value, as object keys and array indexes; empty for the root. */
  readonly path: readonly (string | number)[];
  /** One-line explanation. */
  readonly message: string;
}

/** A rejected delivery: invalid input is exit 2, a closed/already answered question is exit 3. */
export class AnswerError extends Error {
  static {
    brandError(this, 'AnswerError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is AnswerError {
    return isBranded(this, value);
  }

  /** Distinguishes validation from first-answer or lifecycle conflicts. */
  public readonly reason: 'invalid' | 'conflict';
  /** Why an `invalid` answer was refused; empty for a conflict. */
  public readonly issues: readonly AnswerIssue[];
  public constructor(
    reason: 'invalid' | 'conflict',
    message: string,
    issues: readonly AnswerIssue[] = [],
  ) {
    super(message);
    this.name = 'AnswerError';
    this.reason = reason;
    this.issues = issues;
  }
}

/** Collapse whitespace runs, including newlines, so a message stays on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** An invalid-answer refusal with one synthetic issue at the root. */
function syntheticInvalid(code: string, error: unknown): AnswerError {
  const message = oneLine(error instanceof Error ? error.message : String(error));
  return new AnswerError('invalid', message, [{ code, path: [], message }]);
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
  const by = options.by ?? 'agent:unspecified';
  let value: JsonValue;
  try {
    value = jsonValue(options.value, 'Answer');
  } catch (error) {
    throw syntheticInvalid('answer_not_json', error);
  }
  let validator: z.ZodType;
  try {
    const schema = step.question.request.schema;
    if (
      typeof schema !== 'boolean' &&
      (schema === null || Array.isArray(schema) || typeof schema !== 'object')
    )
      throw new Error('Stored question schema is not a JSON Schema object.');
    validator = z.fromJSONSchema(schema);
  } catch (error) {
    throw syntheticInvalid('question_schema_invalid', error);
  }
  const parsed = validator.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
      message: oneLine(issue.message),
    }));
    throw new AnswerError(
      'invalid',
      `Answer does not match the question schema: ${issues
        .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ')}`,
      issues,
    );
  }
  const at = new Date().toISOString();
  try {
    validateAnswerAuthor(step.question.request.audience, by);
    answerEnvelopeSchema.parse({ value, by, at, questionFingerprint: step.fingerprint });
  } catch (error) {
    throw syntheticInvalid('answer_author', error);
  }
  const serialized = JSON.stringify({ value, by, at, questionFingerprint: step.fingerprint });
  if (Buffer.byteLength(serialized) > 1_048_576)
    throw syntheticInvalid('answer_too_large', new Error('Answer envelope exceeds 1 MiB.'));
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
      await syncHandle(file);
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
  await withdrawDeliveryIfRunRemoved(stateDir, run, path);
  return { runId: run.id, stepId: options.stepId, path, questionFingerprint: step.fingerprint };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The lock-free half of the `workflow rm` handshake (ADR 0049): after publishing a delivery,
 * re-read the run and withdraw the delivery when the run is gone or the ID now names another run
 * (a different `createdAt`). rm's commit point (removing the flat file, or renaming `<runId>/` to
 * its tombstone) precedes its final sweep of the legacy siblings. So a link before the commit point
 * is swept with `<runId>.inbox/` or moved into the tombstone with `<runId>/inbox/`, and a link after
 * it finds the run gone here; either way no answer outlives the run to reach a later run that reuses
 * the ID. Empty inbox and run directories this delivery recreated are removed too.
 * @internal
 */
export async function withdrawDeliveryIfRunRemoved(
  stateDir: string,
  run: Pick<RunRecord, 'id' | 'createdAt'>,
  path: string,
): Promise<void> {
  const current = await readRun({ stateDir, runId: run.id }).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (current?.createdAt === run.createdAt) return;
  await rm(path, { force: true });
  // Only a removed run's directories: a run that reuses the ID owns its own.
  if (!current)
    for (const directory of [dirname(path), runDirectory(stateDir, run.id)])
      try {
        await rmdir(directory);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error)) throw error;
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))) throw error;
      }
  throw new AnswerError(
    'conflict',
    `Run ${run.id} was removed while the answer was being delivered.`,
  );
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
  launcher?: CommandLauncher,
): Promise<PendingOperation[]> {
  const codeChanged = await questionCodeChanged(run);
  const pending: PendingOperation[] = [];
  for (const [stepId, step] of Object.entries(run.steps)) {
    if (step.status !== 'waiting') continue;
    const answerCommand = step.question
      ? workflowArgv(
          launcher,
          'answer',
          run.id,
          stepId,
          '--state-dir',
          stateDir,
          '--json',
          '<ANSWER_JSON>',
        )
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
        lastError: step.wait.lastError ? structuredClone(step.wait.lastError) : null,
        signal: step.question ? structuredClone(step.question.request) : null,
        command: structuredClone(step.wait.request.poll?.command?.exec.command ?? null),
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

/** Options for {@link listPending}. */
export interface ListPendingOptions extends StateDirectoryOptions {
  /** Program words that start each `answerCommand`; defaults to `['quiet-choir']`. */
  readonly commandLauncher?: CommandLauncher;
}

/**
 * Read a question's inbox delivery state. The first existing candidate file means `queued`; its
 * time and author come from the envelope, and are null when the file is unreadable or malformed
 * (a refused delivery is still in the way of a second answer). An owner consuming the file can make
 * a row read `none` for a moment, so this is advisory.
 */
async function readDelivery(
  stateDir: string,
  runId: string,
  stepId: string,
): Promise<PendingDelivery> {
  for (const candidate of answerCandidates(stateDir, runId, stepId)) {
    let text: string;
    try {
      text = await readFile(candidate, 'utf8');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return { state: 'queued', at: null, by: null };
    }
    try {
      const envelope = answerEnvelopeSchema.safeParse(JSON.parse(text));
      if (envelope.success) return { state: 'queued', at: envelope.data.at, by: envelope.data.by };
    } catch {
      // Not JSON: still queued, with no attribution.
    }
    return { state: 'queued', at: null, by: null };
  }
  return { state: 'none', at: null, by: null };
}

/** Every run's waiting rows with run and delivery state, one group per run that has any. @internal */
export async function listPendingRuns(
  options: ListPendingOptions = {},
): Promise<{ run: RunRecord; pending: PendingListing[] }[]> {
  const stateDir = resolveStateDir(options);
  const groups: { run: RunRecord; pending: PendingListing[] }[] = [];
  for (const runId of await listRunIds(stateDir)) {
    const run = await readRun({ stateDir, runId });
    const operations = await pendingOperations(run, stateDir, options.commandLauncher);
    if (!operations.length) continue;
    groups.push({
      run,
      pending: await Promise.all(
        operations.map(async (operation) => ({
          ...operation,
          runStatus: run.status,
          delivery: operation.answerCommand
            ? await readDelivery(stateDir, run.id, operation.stepId)
            : null,
        })),
      ),
    });
  }
  return groups;
}

/**
 * List parked questions, polls, and deadlines by reading state only; never imports code. Every
 * waiting row is returned, whatever its run's status or delivery state, with that status and the
 * inbox delivery state added.
 */
export async function listPending(options: ListPendingOptions = {}): Promise<PendingListing[]> {
  return (await listPendingRuns(options)).flatMap((group) => group.pending);
}
