import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { engineInfo, oldFormatMessage } from './engine.js';
import { digest, jsonValue } from './json.js';
import type { WorkflowDefinition } from './model.js';
import type { StateDirectoryOptions } from './paths.js';
import type { ResumeCheck, SourceFingerprint, WorkflowIdentity } from './replay-model.js';
import { schemaJson } from './schema.js';
import { readRun, type RunRecord } from './store.js';

/** Run-level code metadata for embedding and compatibility inspection. */
export interface WorkflowCodeOptions {
  /** Opaque embedded code identity. Mutually exclusive with source. */
  readonly fingerprint?: string;
  /** Detailed source identity; the CLI supplies this. */
  readonly source?: SourceFingerprint;
}

/** Inputs for a lock-free compatibility check. */
export interface CheckResumeOptions extends StateDirectoryOptions, WorkflowCodeOptions {
  /** Existing run to inspect. */
  readonly runId: string;
  /** Optional replacement input, which must equal the saved validated input. */
  readonly input?: unknown;
  /** Check explicit code/schema acceptance, keeping other run gates intact. */
  readonly acceptCodeChange?: boolean;
}

/** Normalize aliases of an existing directory; keep the legacy treatment of missing directories. @internal */
export async function canonicalCwd(cwd: string | undefined): Promise<string> {
  const path = resolve(cwd ?? process.cwd());
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path;
    throw error;
  }
}

/** Shared validate/run snapshot so the two commands report the same fingerprint. @internal */
export function workflowSnapshot(
  definition: Pick<WorkflowDefinition<unknown, unknown>, 'name' | 'version' | 'input' | 'output'>,
  options: WorkflowCodeOptions,
): { fingerprint: string; identity: WorkflowIdentity } {
  if (options.source !== undefined && options.fingerprint !== undefined)
    throw new Error('Supply source or fingerprint, not both.');
  const identity: WorkflowIdentity = {
    code: options.source?.hash ?? options.fingerprint ?? null,
    files: { ...options.source?.files },
    inputSchema: digest(schemaJson(definition.input)),
    outputSchema: digest(schemaJson(definition.output)),
    engine: { ...engineInfo },
  };
  return { fingerprint: digest(identity), identity };
}

/** Compare run gates without invoking effects or acquiring a lock. @internal */
export function compareResume(
  definition: Pick<WorkflowDefinition<unknown, unknown>, 'name' | 'version' | 'input' | 'output'>,
  options: WorkflowCodeOptions & { readonly input?: unknown; readonly acceptCodeChange?: boolean },
  cwd: string,
  saved: RunRecord,
): ResumeCheck {
  const current = workflowSnapshot(definition, options);
  const prior = saved.workflow.identity;
  const files = [
    ...new Set([...Object.keys(prior?.files ?? {}), ...Object.keys(current.identity.files)]),
  ]
    .filter((file) => prior?.files[file] !== current.identity.files[file])
    .sort();
  let inputMatches = false;
  let inputValid = false;
  try {
    const input = jsonValue(
      definition.input.parse(options.input === undefined ? saved.input : options.input),
    );
    inputValid = true;
    inputMatches = digest(input) === digest(saved.input);
  } catch {
    /* Return an incompatibility report rather than mutating the run. */
  }
  const tests: Record<string, boolean> = {
    name: saved.workflow.name === definition.name,
    version: saved.workflow.version === definition.version,
    code: prior?.code === current.identity.code && files.length === 0,
    'input schema': prior?.inputSchema === current.identity.inputSchema,
    'output schema': prior?.outputSchema === current.identity.outputSchema,
    cwd: saved.cwd === cwd,
    input: inputMatches,
    engine: prior !== undefined && digest(prior.engine) === digest(current.identity.engine),
    'checkpoint format': saved.formatVersion === engineInfo.formatVersion,
  };
  const changed = Object.keys(tests).filter((key) => !tests[key]);
  const unchanged = Object.keys(tests).filter((key) => tests[key]);
  const canAcceptCodeChange = changed.every((key) =>
    ['code', 'input schema', 'output schema'].includes(key),
  );
  const compatible =
    changed.length === 0 || (options.acceptCodeChange === true && canAcceptCodeChange);
  const refinalizable =
    saved.status === 'failed' &&
    Object.values(saved.steps).every((step) => step.status === 'completed');
  const changes = changed
    .map((key) => (key === 'code' && files.length ? `code (${files.join(', ')})` : key))
    .join(', ');
  const hint = refinalizable
    ? ' All recorded effects completed; a tail/output fix can re-finalize with --resume --accept-code-change and zero repeated effects if step identities and replay order remain compatible.'
    : '';
  const message =
    saved.formatVersion !== engineInfo.formatVersion
      ? oldFormatMessage(saved.formatVersion)
      : changed.length === 0
        ? `Run ${saved.id} is compatible at run level; step identity and replay checks still run during execution.${hint}`
        : `Workflow ${changes} changed; ${unchanged.join(', ')} unchanged.${!inputValid ? ' Saved/supplied input does not validate.' : ''} ${canAcceptCodeChange ? `Use --resume --accept-code-change or create a new run with --fork-from ${saved.id}.` : `Start a new run${tests['name'] ? `, optionally with --fork-from ${saved.id}` : ''}.`}${hint}`;
  return {
    compatible,
    changed,
    unchanged,
    files,
    fingerprint: current.fingerprint,
    savedFingerprint: saved.workflow.fingerprint,
    canAcceptCodeChange,
    refinalizable,
    message,
  };
}

/** Read compatibility without a writer lock or workflow-body execution; imports are the caller's responsibility. */
export async function checkResume<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
  options: CheckResumeOptions,
): Promise<ResumeCheck> {
  return compareResume(
    definition,
    options,
    await canonicalCwd(options.cwd),
    await readRun(options),
  );
}
