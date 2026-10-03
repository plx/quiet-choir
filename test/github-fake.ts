// Shared harness of the GitHub write tests (test/github-writes.test.ts and
// test/github-pr-writes.test.ts): the stateful fake gh on PATH, workflow setup, and the dry-run
// rehearsal of a workflow file.
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import {
  defineWorkflow,
  NodeProcessRunner,
  z,
  type JsonValue,
  type ProcessRunner,
  type RunRecord,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../src/index.js';
import { createFakeBinary, type FakeBinary } from '../src/harness-kit.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { RehearsalCommand } from '../src/workflow/loader/rehearsal.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';

/** The repository checkout. */
export const repository = dirname(dirname(fileURLToPath(import.meta.url)));
/** The fake's repository. */
export const REPO = 'octo-org/quiet-choir';
/** The fake's viewer. */
export const VIEWER = 'octo-bot';

/** One logged gh call. */
export interface FakeCall {
  readonly argv: readonly string[];
  readonly stdin: string | null;
}

/** A fake with its runner and a reader of its state file. */
export interface Fake<S> {
  readonly runner: ProcessRunner;
  readonly state: () => Promise<S>;
}

/** Run options for a workflow under `cwd()`. */
export interface Setup {
  readonly cwd: string;
  readonly stateDir: string;
  readonly runId: string;
  readonly input: null;
}

/** A rehearsal's run and the commands it listed. */
export interface Rehearsal {
  readonly run: RunRecord;
  readonly commands: readonly RehearsalCommand[];
}

/** What {@link useGithubFake} gives a test file. */
export interface GithubFake {
  /** This test's temporary directory. */
  readonly cwd: () => string;
  /** Seed the fake's state; return a runner that puts the fake on PATH and a state reader. */
  readonly fake: <S>(seed?: object) => Promise<Fake<S>>;
  /** Run options for `runId`. */
  readonly setup: (runId: string) => Setup;
  /** Rehearse a workflow file under `--dry-run`, failing if a process would be spawned. */
  readonly rehearse: (file: string, input: JsonValue) => Promise<Rehearsal>;
  /** Make `cwd()` a module project that resolves this checkout's dependencies. */
  readonly project: () => Promise<void>;
}

/** A workflow with null input and unknown output. */
export const definition = (
  run: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition<null, unknown> =>
  defineWorkflow({
    name: 'github-writes',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run,
  });

/**
 * Register the hooks of one test file: the fake gh (test/bin/fake-gh-writes.mjs) installed once, a
 * fresh temporary directory per test, and environment stubs undone after it.
 */
export function useGithubFake(prefix: string): GithubFake {
  let gh: FakeBinary;
  let cwd = '';
  beforeAll(async () => {
    gh = await createFakeBinary(
      'gh',
      readFileSync(join(repository, 'test', 'bin', 'fake-gh-writes.mjs'), 'utf8'),
    );
  });
  afterAll(async () => {
    await gh.dispose();
  });
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  /** Seed the fake's state; return a runner that puts the fake on PATH and a state reader. */
  async function fake<S>(seed: object = {}): Promise<Fake<S>> {
    const path = join(cwd, 'gh-state.json');
    await writeFile(
      path,
      JSON.stringify({
        comments: {},
        threads: {},
        issues: {},
        alerts: {},
        pulls: {},
        runs: {},
        crashAfterCommit: null,
        calls: [],
        ...seed,
      }),
    );
    const native = new NodeProcessRunner();
    return {
      runner: {
        run: (request, invocation) =>
          native.run(
            { ...request, env: { ...request.env, ...gh.env, FAKE_GH_STATE: path } },
            invocation,
          ),
      },
      state: async () => JSON.parse(await readFile(path, 'utf8')) as S,
    };
  }

  const setup = (runId: string): Setup => ({
    cwd,
    stateDir: join(cwd, 'state'),
    runId,
    input: null,
  });

  /** Rehearse a workflow file under `--dry-run` with a runner that fails if it is ever reached. */
  async function rehearse(file: string, input: JsonValue): Promise<Rehearsal> {
    const analysis = analyzeTypecheckEntrypoint(file, cwd);
    if (!analysis.ok) throw new Error('invalid workflow fixture');
    const spawned: unknown[] = [];
    const result = await new WorkflowExecutor({
      logger: new ThresholdLogger('silent', () => undefined),
      processRunner: {
        run: (request) => {
          spawned.push(request.command);
          return Promise.reject(new Error('A dry run reached the process runner.'));
        },
      },
    }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'dry',
      stateDir: join(cwd, 'state'),
      cwd,
      input,
      resume: false,
      harness: { kind: 'cli', config: {} },
      dryRun: true,
    });
    if (result.kind !== 'workflow.run.result' || !result.rehearsal)
      throw new Error(JSON.stringify(result));
    expect(spawned).toEqual([]);
    return { run: result.run, commands: result.rehearsal.commands };
  }

  /** Make `cwd()` a module project that resolves this checkout's dependencies. */
  async function project(): Promise<void> {
    await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
    await symlink(join(repository, 'node_modules'), join(cwd, 'node_modules'));
  }

  return { cwd: () => cwd, fake, setup, rehearse, project };
}

/** Point a docs snippet's package imports at this checkout's sources. */
export const imports = (source: string): string =>
  source
    .replace("'quiet-choir/github'", JSON.stringify(join(repository, 'src/integrations/github.js')))
    .replace("'quiet-choir'", JSON.stringify(join(repository, 'src/index.js')));

/** The commands a rehearsal listed. */
export type RehearsedCommands = Rehearsal['commands'];
