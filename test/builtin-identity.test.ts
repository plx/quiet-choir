import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  WorkflowRunError,
  z,
  type MergeCommitOptions,
  type ProcessRunner,
  type RunOptions,
  type StepContext,
  type WorkflowContext,
} from '../src/index.js';
import { decision } from '../src/integrations/decision.js';
import {
  codeqlReviewer,
  codexReviewer,
  github,
  pullRequestViewResponseSchema,
  type GithubClient,
  type GithubWritePolicy,
} from '../src/integrations/github.js';
import { digest } from '../src/workflow/runtime/json.js';
import { agentIdentity, type StepIdentity } from '../src/workflow/runtime/identity.js';
import type { HarnessDeclaration } from '../src/workflow/runtime/harness-model.js';
import { claudeDefinition } from '../src/harnesses/builtins/definitions.js';

// The golden fingerprints include the cwd digest, so the cwd is fixed and never a temp directory.
const cwd = '/golden-cwd';
let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-builtin-identity-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/**
 * One message for every golden, so the guidance is identical wherever a pin fails.
 * The pinned values are literal, never a snapshot that `vitest -u` could rewrite.
 */
function message(name: string): string {
  return [
    `Pinned built-in step identity changed: ${name}.`,
    `Changing it makes completed steps of existing suspended runs refuse on resume with "changed on a completed step".`,
    `Do not just update the golden: see docs/decisions/0005-step-identity-and-policy.md and the durability reference, plugins/*/quiet-choir/skills/quiet-choir/references/durability.md.`,
    `Bump a built-in's version constant (now/1, decision/1) only for a deliberate behavior change, and record the one-time break in CHANGELOG.md.`,
  ].join('\n');
}

/** Compare against a literal value; the only assertion path for goldens in this file. */
function pinned(name: string, actual: unknown, expected: unknown): void {
  expect(actual, message(name)).toEqual(expected);
}

const workflow = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({
    name: 'builtin-identity',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: async (ctx) => {
      await run(ctx);
      return null;
    },
  });
const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'golden',
  stateDir,
  input: null,
  fingerprint: 'golden',
  cwd,
  ...overrides,
});
function identityOf(step: { readonly identity?: StepIdentity }): StepIdentity {
  if (!step.identity) throw new Error('Step has no recorded identity.');
  return step.identity;
}
async function recorded(runId = 'golden'): Promise<Record<string, StepRecordIdentity>> {
  const run = await readRun({ stateDir, runId });
  return Object.fromEntries(
    Object.entries(run.steps).map(([id, step]) => [
      id,
      { identity: identityOf(step), fingerprint: step.fingerprint },
    ]),
  );
}
interface StepRecordIdentity {
  readonly identity: StepIdentity;
  readonly fingerprint: string;
}

const sharedComponents = {
  cwd: '57b3000557c37127e98bf8b89621d12ab3ae2669d37a5fd4b07b36486b88667e',
  kind: '0d9f50d8178cb7c5b044c4dce43f1a35c44697ac03e70407e2dda2324fa92f56',
  onError: 'a8ae35eaddff8b9970e3075d77d711798ddfa511a5391581aef83e1a8ebbf64f',
};

describe('built-in step identity', () => {
  it('pins ctx.now and decision.choose without a callback component', async () => {
    const definition = workflow(async (ctx) => {
      await ctx.now('started-at');
      await decision(ctx, () =>
        Promise.resolve({ output: { answer: 'yes', probabilities: { yes: 1, no: 0 } } }),
      ).choose('pick', { state: null, question: 'golden?', answers: ['yes', 'no'] });
    });
    await runWorkflow(definition, options());
    const steps = await recorded();
    expect(steps['started-at']?.identity).not.toHaveProperty('callback');
    expect(steps['pick']?.identity).not.toHaveProperty('callback');
    pinned('ctx.now version', steps['started-at']?.identity['version'], digest('now/1'));
    pinned('decision.choose version', steps['pick']?.identity['version'], digest('decision/1'));
    pinned(
      'decision.choose version digest',
      digest('decision/1'),
      '9877238849fe9f70252af45aaa4dc864cd4d1e18f0a6425749c9dc79c263a00c',
    );
    pinned('ctx.now', steps['started-at'], {
      identity: {
        ...sharedComponents,
        input: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
        schema: '63cd27a58e68ba86d947651d017132f4047c5f4f75d0984e107921b3293f20c4',
        version: 'ef6a278dd5d8158fa3434604272b65ef77886edc6efaf60cee77ea6e6f0d8e27',
      },
      fingerprint: '9c0e758ae1e316f1da267fa93b21487ab1dda884abba2e41b30abffc3df512c7',
    });
    pinned('decision.choose', steps['pick'], {
      identity: {
        ...sharedComponents,
        input: '96b2d77790b9809ed66856eab86eb88be932e77eb6b4b66e6bf88f6ef6577f27',
        schema: '65af6e34af3412c5c937973da894109888b658664721c7adbba872792e06324a',
        version: '9877238849fe9f70252af45aaa4dc864cd4d1e18f0a6425749c9dc79c263a00c',
      },
      fingerprint: '1454bdc9114a8108a88661d30b4b66a264c445e0440b378e4981caffd11eb175',
    });
  });

  it('keeps the identity of a plain user step, captured before the change', async () => {
    const definition = workflow((ctx) =>
      ctx.step('user', { input: null, schema: z.string(), run: () => 'one' }),
    );
    await runWorkflow(definition, options());
    pinned('plain user ctx.step', (await recorded())['user'], {
      identity: {
        ...sharedComponents,
        callback: 'ca46dc0e120517c354203afe5e9d785ddc0f8d00ce9488c68e4eac0df4f09033',
        input: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
        schema: '42c50030e717f64ef6435e786fcb4b3dc38968555e23764a7902b7e5032bc966',
        version: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      },
      fingerprint: '4cf8b45f2059dd887e31d9b30a0acf2749c551650d47f96c5025a42196afcc7a',
    });
  });
});

describe('steps whose callback runs context.exec', () => {
  it('keep the plain step identity components; the command enters no identity', async () => {
    const processRunner: ProcessRunner = {
      run: () =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout: 'one',
          stderr: '',
          truncated: false,
          durationMs: 1,
        }),
    };
    const run = async (context: StepContext): Promise<string> =>
      (await context.exec(['golden', 'arg'])).stdout;
    const definition = workflow((ctx) =>
      ctx.step('user', { input: null, schema: z.string(), run }),
    );
    await runWorkflow(definition, options({ processRunner }));
    const steps = await recorded();
    // The same components and values as the plain user step pinned above, except the callback
    // text; no exec summary or command component is added.
    pinned('ctx.step with context.exec', steps['user'], {
      identity: {
        ...sharedComponents,
        callback: digest(Function.prototype.toString.call(run)),
        input: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
        schema: '42c50030e717f64ef6435e786fcb4b3dc38968555e23764a7902b7e5032bc966',
        version: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      },
      fingerprint: steps['user']?.fingerprint,
    });
    expect(steps['user']?.fingerprint).toBe(digest(steps['user']?.identity));
    expect(Object.keys(steps)).toEqual(['user']);
  });
});

describe('version-identified steps', () => {
  it('survives a rewritten callback, but not a version change', async () => {
    let calls = 0;
    let callback = (): string => {
      calls++;
      return 'one';
    };
    const definition = (version: string) =>
      workflow(async (ctx) => {
        await ctx.step('flagged', {
          identity: 'version',
          version,
          input: null,
          schema: z.string(),
          run: callback,
        });
        throw new Error('tail');
      });
    await expect(runWorkflow(definition('r9/1'), options())).rejects.toThrow('tail');
    const before = (await recorded())['flagged'];
    callback = () => {
      calls++;
      return 'one';
    };
    await expect(
      runWorkflow(definition('r9/1'), options({ resume: true, fingerprint: 'code-2' })),
    ).rejects.toThrow('tail');
    expect(calls).toBe(1);
    expect((await recorded())['flagged']?.fingerprint).toBe(before?.fingerprint);
    const rejected = await runWorkflow(
      definition('r9/2'),
      options({ resume: true, fingerprint: 'code-3', acceptCodeChange: true }),
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(WorkflowRunError);
    expect((rejected as Error).message).toContain('version changed on a completed step');
    expect(calls).toBe(1);
  });

  it('still hashes callback text without the flag', async () => {
    let callback = (): string => 'one';
    const definition = workflow(async (ctx) => {
      await ctx.step('plain', { version: 'r9/1', input: null, schema: z.string(), run: callback });
      throw new Error('tail');
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    const first = (await recorded())['plain'];
    callback = () => {
      return 'one';
    };
    const rejected = await runWorkflow(
      definition,
      options({ resume: true, fingerprint: 'code-2', acceptCodeChange: true }),
    ).catch((error: unknown) => error);
    expect((rejected as Error).message).toContain('callback changed on a completed step');
    await runWorkflow(definition, options({ runId: 'other' })).catch(() => undefined);
    expect((await recorded('other'))['plain']?.fingerprint).not.toBe(first?.fingerprint);
  });

  it('rejects a missing or blank version and an unknown identity', async () => {
    const attempt = (definition: Record<string, unknown>) =>
      runWorkflow(
        workflow((ctx) =>
          ctx.step('bad', {
            input: null,
            schema: z.string(),
            run: () => 'one',
            ...definition,
          } as Parameters<WorkflowContext['step']>[1]),
        ),
        options({ runId: `bad-${Math.random().toString(36).slice(2)}` }),
      );
    for (const definition of [
      { identity: 'version' },
      { identity: 'version', version: '  ' },
      { identity: 'bogus', version: 'x/1' },
    ])
      await expect(attempt(definition)).rejects.toThrow(/Step bad: .*nonempty string version/s);
  });

  it('refuses once when a record holds the pre-change ctx.now identity', async () => {
    const definition = workflow(async (ctx) => {
      await ctx.now('started-at');
      throw new Error('tail');
    });
    await expect(runWorkflow(definition, options())).rejects.toThrow('tail');
    const run = await readRun({ stateDir, runId: 'golden' });
    const step = run.steps['started-at'];
    if (!step) throw new Error('missing step');
    const identity = {
      ...identityOf(step),
      callback: '0deb0c1a83ed22c3d02611f3770e9a8d645ca134c329bbe547889eca63d75983',
      version: digest(null),
    };
    step.identity = identity;
    step.fingerprint = digest(identity);
    const directory = join(stateDir, 'golden');
    await writeFile(join(directory, 'run.json'), `${JSON.stringify(run)}\n`);
    await writeFile(join(directory, 'journal.jsonl'), '');
    const rejected = await runWorkflow(
      definition,
      options({ resume: true, fingerprint: 'code-2', acceptCodeChange: true }),
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(WorkflowRunError);
    expect((rejected as Error).message).toContain('callback, version changed on a completed step');
    expect(await readFile(join(directory, 'run.json'), 'utf8')).toContain('started-at');
  });
});

describe('exec and file effect identity', () => {
  // Captured on the code before #149 added onError to these effects. Path-dependent components
  // (cwd, path) are compared against the digest of the canonical temporary path instead.
  it.each<'throw' | undefined>([undefined, 'throw'])(
    'keeps exec, exec.json, readFile and writeFile identities with onError %j',
    async (mode) => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'choir-effect-identity-')));
      try {
        await writeFile(join(dir, 'in.txt'), 'golden');
        const processRunner: ProcessRunner = {
          run: () =>
            Promise.resolve({
              code: 0,
              signal: null,
              stdout: '{"ok":true}',
              stderr: '',
              truncated: false,
              durationMs: 1,
            }),
        };
        const onError = mode === undefined ? {} : { onError: mode };
        const effects = workflow(async (ctx) => {
          await ctx.exec('plain', ['golden', 'arg'], onError);
          await ctx.exec.json('json', ['golden', 'json'], {
            schema: z.object({ ok: z.boolean() }),
            ...onError,
          });
          await ctx.readFile('read', 'in.txt', onError);
          await ctx.writeFile('write', 'out.txt', 'golden', onError);
        });
        await runWorkflow(effects, options({ cwd: dir, processRunner }));
        const steps = await recorded();
        for (const step of Object.values(steps))
          expect(step.fingerprint).toBe(digest(step.identity));
        const exec = {
          cwd: digest(dir),
          envSha256: 'ba4b4c01512909e214270a4f23ef856ea7857d763cbab32fe7381b0dc204523d',
          inheritEnv: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
          inputSha256: 'b4b16dad390bac4c7ce42014c594fa668910b49ec1b7771a17891c187d71e0ab',
          kind: '37c9a5bba64484ff1971b80862a96916501e4624e59e717e16e7686f6f41be73',
          okExitCodes: 'd0bca111f8628137adc4c16f123496dcdd1d590d06cb5d9acd68b39fe656fb97',
        };
        pinned('ctx.exec', steps['plain']?.identity, {
          ...exec,
          command: '2b653fe7df7f2e8cff409dea7f2a72520752b094d249ba67f458e328eba208fa',
          schema: 'ff62d310ae73387abafa02c2437810c9303d006a5af94c037f5f9c0754828d1a',
          structured: 'fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa',
        });
        pinned('ctx.exec.json', steps['json']?.identity, {
          ...exec,
          command: '9ee6ad123c2ad9a7453f0366928c854f376fcf8ca9f7f3325b94fe5416b5a416',
          schema: '3100ed3d183ac9ab1eeb5b77a47021a4ca2b831f69185104c5faa7e461cb02ef',
          structured: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
        });
        pinned('ctx.readFile', steps['read']?.identity, {
          kind: '990a232f429cdef5d4722cb255c20b8a3495191448b72fc4ff9e997f7853afe9',
          path: digest(join(dir, 'in.txt')),
          schema: 'efb42a696b43c0c91707a3e3749aeb13ad7f263d66ed61f7588dc5dec74615de',
        });
        pinned('ctx.writeFile', steps['write']?.identity, {
          createOnly: 'fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa',
          ifMatch: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
          kind: '090ae1ddad0ad99982b216f113b6d027089f1ffce713684d129645e78d218241',
          path: digest(join(dir, 'out.txt')),
          schema: '061958b1f65c8220a5d098d97e1da1a86cea8de07e1fea3841fa3bcfa7bcbc99',
          sha256: '41d98affbe759a061d6c1386cca894e9760e563f055732e987681fababde3b47',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('quiet-choir/github read identity', () => {
  // Every gh call fails, so each read fails after recording its identity.
  const processRunner: ProcessRunner = {
    run: () =>
      Promise.resolve({
        code: 2,
        signal: null,
        stdout: '',
        stderr: 'gh: golden',
        truncated: false,
        durationMs: 1,
      }),
  };
  const reads: Readonly<Record<string, (gh: GithubClient) => Promise<unknown>>> = {
    'repo.info': (gh) => gh.repo.info('read'),
    'pr.view': (gh) => gh.pr.view('read', { number: 7 }),
    'pr.list': (gh) => gh.pr.list('read', { base: 'main' }),
    'pr.reviewThreads': (gh) => gh.pr.reviewThreads('read', { number: 7 }),
    'issue.view': (gh) => gh.issue.view('read', { number: 7 }),
    'issue.view comments': (gh) => gh.issue.view('read', { number: 7, comments: true }),
    'codeScanning.alerts': (gh) => gh.codeScanning.alerts('read', { ref: 'refs/pull/7/merge' }),
  };
  async function identityOfRead(
    name: string,
    read: (gh: GithubClient) => Promise<unknown>,
  ): Promise<StepRecordIdentity & { argv: readonly string[] }> {
    const runId = name.replace(/[^A-Za-z0-9]/gu, '-');
    let argv: readonly string[] = [];
    await runWorkflow(
      workflow((ctx) => read(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      options({
        runId,
        processRunner: {
          run: (request, invocation) => {
            argv = request.command as readonly string[];
            return processRunner.run(request, invocation);
          },
        },
      }),
    ).catch(() => undefined);
    const step = (await recorded(runId))['read'];
    if (!step) throw new Error(`${name} recorded no step`);
    return { ...step, argv };
  }
  // The plain-exec literals pinned in 'exec and file effect identity' above: no environment
  // overlay, empty stdin, inherited environment, structured output.
  const plainExec = {
    cwd: sharedComponents.cwd,
    envSha256: 'ba4b4c01512909e214270a4f23ef856ea7857d763cbab32fe7381b0dc204523d',
    inheritEnv: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
    inputSha256: 'b4b16dad390bac4c7ce42014c594fa668910b49ec1b7771a17891c187d71e0ab',
    kind: '37c9a5bba64484ff1971b80862a96916501e4624e59e717e16e7686f6f41be73',
    okExitCodes: 'd0bca111f8628137adc4c16f123496dcdd1d590d06cb5d9acd68b39fe656fb97',
    structured: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
  };
  // Captured on this change. A deliberate change to a query, argv shape or response schema moves
  // these digests and strands in-flight runs of that read; see the message above.
  const golden: Readonly<
    Record<string, { command: string; schema: string; okExitCodes?: string }>
  > = {
    'repo.info': {
      command: 'f089e5f7152ff90d96e442c823363e3e2ddccce9ae9b9c113dfec19075ed82ae',
      schema: '18ca13faafb7ec255bab4395f149706f85c69ec97f9473af7833193f54ab88a6',
    },
    'pr.view': {
      command: '661ba1f230681bd5877b557f4f139e3cf1842a7a18d80f44a1878b0dd37cf200',
      schema: '6d3c7ddfca3d2c56525f528d937d722878e45130b59f34d7141c697ffc861032',
    },
    'pr.list': {
      command: 'efa8d91dfbf2b5273171758c0ad3de1f107a852459f57c26ffc696a33b4346a1',
      schema: '735f04183548dfee20770e853d870211fd8228c3478a9603edd8319a27062bf3',
    },
    'pr.reviewThreads': {
      command: '8fb9a414cb2d9359c98e4020c171bb3e32dc1d303a03261db0bba213f8109158',
      schema: 'e838e29d87512f35075052373b85d0bee5dfdb4a00880c7022a7bbbc8dddb51c',
    },
    'issue.view': {
      command: '5d8f7d277f3a5cebe6f895bdffdcbbae61efc00d65d117c6901dddc26ca6cfc2',
      schema: 'a8da9fef5dbc0897a6dae88cc29be948d6f0b75fc17d4ce188cda9f50c1026b4',
    },
    'issue.view comments': {
      command: 'ebd330228a548f04dd4894014882004eaef47c39f38a0374ab316ccdcf3c3282',
      schema: 'fd040ea0ecc40bfa0a91eda4ab65297630fbb7c5e05335397edefb836d30183b',
    },
    'codeScanning.alerts': {
      command: 'f0f1260181280e10bb60c775e3905cac94a6fc851b1444c1f94c162be558a245',
      schema: 'ec1cd0b6a90d9e2a4123a195e60d3306a4967237eac7c245c0ba6c877471a8c5',
      // [0, 1]: gh's exit 1 for an HTTP error is accepted, and the schema decides.
      okExitCodes: '463f2998327eb3a694145e6014444480b2235be84aa6cfd57871cc64f1cd816c',
    },
  };

  it.each(Object.keys(reads))(
    'pins %s to argv, schema and the fixed exec defaults',
    async (name) => {
      const read = reads[name];
      const expected = golden[name];
      if (!read || !expected) throw new Error(`unknown read ${name}`);
      const step = await identityOfRead(name, read);
      pinned(`quiet-choir/github ${name}`, step.identity, { ...plainExec, ...expected });
      expect(step.fingerprint).toBe(digest(step.identity));
      // Argv-only identity: no helper component, interpreter, program source, overlay or stdin.
      expect(step.identity).not.toHaveProperty('helper');
      expect(step.identity['envSha256']).toBe(digest(digest({})));
      expect(step.identity['inputSha256']).toBe(
        digest(createHash('sha256').update('').digest('hex')),
      );
      expect(step.argv[0]).toBe('gh');
      for (const argument of step.argv) {
        expect(argument).not.toContain(process.execPath);
        expect(argument).not.toMatch(/(?:^|[\\/])node(?:\.exe)?$/u);
      }
    },
  );

  it('keeps a read identical to a plain exec.json of the same argv and schema, so meta is not identity', async () => {
    const step = await identityOfRead('labelled', reads['pr.view'] ?? (() => Promise.resolve()));
    await runWorkflow(
      workflow((ctx) =>
        ctx.exec.json('read', step.argv as [string, ...string[]], {
          schema: pullRequestViewResponseSchema,
        }),
      ),
      options({ runId: 'unlabelled', processRunner }),
    ).catch(() => undefined);
    const plain = (await recorded('unlabelled'))['read'];
    expect(plain?.identity).toEqual(step.identity);
    expect(plain?.fingerprint).toBe(step.fingerprint);
    const run = await readRun({ stateDir, runId: 'labelled' });
    expect(run.steps['read']?.meta).toEqual({ integration: 'github', op: 'pr.view' });
    expect((await readRun({ stateDir, runId: 'unlabelled' })).steps['read']).not.toHaveProperty(
      'meta',
    );
  });
});

describe('quiet-choir/github wait identity', () => {
  // Every gh call fails; the waits tolerate it and suspend after recording their identity.
  const processRunner: ProcessRunner = {
    run: () =>
      Promise.resolve({
        code: 2,
        signal: null,
        stdout: '',
        stderr: 'gh: golden',
        truncated: false,
        durationMs: 1,
      }),
  };
  const sha = 'c5c2233fa0c0b9e89b688f2c40ca9364275efd87';
  const waits: Readonly<Record<string, (gh: GithubClient) => Promise<unknown>>> = {
    waitChecks: (gh) => gh.waitChecks('wait', { pr: 7, sha, timeoutMs: 3_600_000 }),
    waitPr: (gh) => gh.waitPr('wait', { pr: 7, sha, until: 'merged', timeoutMs: 3_600_000 }),
    waitReview: (gh) =>
      gh.waitReview('wait', {
        pr: 7,
        sha,
        since: 1_800_000_000_000,
        reviewers: [codexReviewer(), codeqlReviewer()],
        timeoutMs: 3_600_000,
      }),
  };
  // Captured on this change. The input, result schema, spacing and the helper's versioned identity
  // ({ helper: 'github.waitChecks', version: 1 } and so on) are pinned; the observer's source text
  // is not part of it. A deliberate change bumps the helper's version and moves these values.
  const golden: Readonly<Record<string, string>> = {
    waitChecks: 'f9f2cf35c8bc2cedb690af8828560cd522a15b85a3b85f1c8e82cb980f674f1e',
    waitPr: '47a4d9226695eb1181357d0474c22bc92b3f3f63cec4a9b93a394600b0965676',
    waitReview: '1db7a3d0436d20e00257e6d2fb5da681a2c90f265f4cd06a6c16810cd4cdc00d',
  };

  it.each(Object.keys(waits))(
    'pins %s to its input, schema and versioned helper identity',
    async (name) => {
      const wait = waits[name];
      if (!wait) throw new Error(`unknown wait ${name}`);
      const result = await runWorkflow(
        workflow((ctx) => wait(github(ctx, { repo: 'octo-org/quiet-choir' }))),
        options({ runId: name, processRunner }),
      );
      expect(result.status).toBe('suspended');
      const run = await readRun({ stateDir, runId: name });
      const step = run.steps['wait'];
      expect(step?.kind).toBe('wait');
      const helper = { helper: `github.${name}`, version: 1 };
      expect(step?.wait?.request.poll?.observe).toBe(digest({ helper }));
      pinned(`quiet-choir/github ${name}`, step?.fingerprint, golden[name]);
    },
  );
});

describe('quiet-choir/github write identity', () => {
  // Every gh call fails, so each write's step fails after recording its identity.
  const processRunner: ProcessRunner = {
    run: () =>
      Promise.resolve({
        code: 2,
        signal: null,
        stdout: '',
        stderr: 'gh: golden',
        truncated: false,
        durationMs: 1,
      }),
  };
  const writes: Readonly<
    Record<string, (gh: GithubClient, policy?: GithubWritePolicy) => Promise<unknown>>
  > = {
    comment: (gh, policy) => gh.comment('write', { number: 7, body: 'golden' }, policy),
    'thread.reply': (gh, policy) =>
      gh.thread.reply('write', { threadId: 'PRRT_golden', body: 'golden' }, policy),
    'issue.create': (gh, policy) =>
      gh.issue.create(
        'write',
        { title: 'golden', body: 'golden', labels: ['bug'], parent: 5 },
        policy,
      ),
    'issue.close': (gh, policy) =>
      gh.issue.close('write', { number: 7, comment: 'golden', reason: 'not_planned' }, policy),
    'issue.reopen': (gh, policy) => gh.issue.reopen('write', { number: 7 }, policy),
    'alert.dismiss': (gh, policy) =>
      gh.alert.dismiss('write', { number: 3, comment: 'golden' }, policy),
  };
  // Captured on this change. The input (repository and normalized arguments), the result schema and
  // the op's version constant (github.comment/1 and so on) are pinned; the callback's source text
  // and the policy are not. A deliberate change of an op's behaviour bumps its version.
  const golden: Readonly<Record<string, string>> = {
    comment: '81fc3378aa8a4c0a7b78a1dbb0152b6ee1013409fab04c35664336a22ffac020',
    'thread.reply': '7b8b7cf2c3f41aeaa7d6f7bb77a30e4fbadd9bb968912eb7aed5fba85681dc3b',
    'issue.create': 'b45fe9184afc5950c5496dc60f9bba0b6edc87f68b9a606384cef228a5adf803',
    'issue.close': 'bb198f1ffd295871305ad5d9a5caf57bf26d1fd77059bfec8201a7f980cfd76e',
    'issue.reopen': '9aeb88dcedb20255b7d06a01257f043fb0f1433bb60a2a0d57f1d5d32fdeda36',
    'alert.dismiss': '3cb90155c05d9ab1ac6b96ec7e5579fddd5482b33432ca42804d7941fd16c706',
  };

  async function identityOfWrite(
    runId: string,
    write: (gh: GithubClient) => Promise<unknown>,
  ): Promise<StepRecordIdentity> {
    await runWorkflow(
      workflow((ctx) => write(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      options({ runId, processRunner }),
    ).catch(() => undefined);
    const step = (await recorded(runId))['write'];
    if (!step) throw new Error(`${runId} recorded no step`);
    return step;
  }

  it.each(Object.keys(writes))(
    'pins %s to its input, result schema and version, without callback text or policy',
    async (name) => {
      const write = writes[name];
      if (!write) throw new Error(`unknown write ${name}`);
      const runId = name.replace(/[^A-Za-z0-9]/gu, '-');
      const step = await identityOfWrite(runId, (gh) => write(gh));
      expect(step.identity).not.toHaveProperty('callback');
      pinned(
        `quiet-choir/github ${name} version`,
        step.identity['version'],
        digest(`github.${name}/1`),
      );
      pinned(`quiet-choir/github ${name}`, step.fingerprint, golden[name]);
      expect(step.fingerprint).toBe(digest(step.identity));
      // Policy is not identity: retry, timeoutMs and maxOutputBytes leave the fingerprint alone.
      const withPolicy = await identityOfWrite(`${runId}-policy`, (gh) =>
        write(gh, {
          retry: { maxAttempts: 2, delayMs: 1 },
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        }),
      );
      expect(withPolicy).toEqual(step);
      const run = await readRun({ stateDir, runId });
      expect(run.steps['write']?.meta).toEqual({ integration: 'github', op: name });
    },
  );
});

describe('merge effect identity', () => {
  // Every git call fails, so the merge step fails after recording its identity.
  const processRunner: ProcessRunner = {
    run: () =>
      Promise.resolve({
        code: 128,
        signal: null,
        stdout: '',
        stderr: 'fatal: golden',
        truncated: false,
        durationMs: 1,
      }),
  };
  const change = { base: 'a'.repeat(40), commit: 'b'.repeat(40), ref: null, files: [] };
  const merge = (runId: string, commit?: MergeCommitOptions) =>
    runWorkflow(
      workflow((ctx) =>
        ctx.merge('integrate', [change], {
          strategy: 'squash',
          target: { branch: 'agent/100' },
          ...(commit === undefined ? {} : { commit }),
        }),
      ),
      options({ runId, processRunner }),
    ).catch(() => undefined);

  it('keeps the identity of a merge without commit, captured before #153', async () => {
    await merge('golden');
    // Computed from e68aba0's sources (before #153 added MergeOptions.commit) and confirmed on
    // this change's base through runWorkflow.
    pinned('ctx.merge without commit', (await recorded())['integrate'], {
      identity: {
        input: '341d33042639ce58200dbfe19d927c17b9289f826d401eff2f138ceed1ee3cd7',
        kind: '532f53631c5865a58c44aeb6665e3c39eff9fcb1369e4ff3066568c964adf93f',
        onError: 'a8ae35eaddff8b9970e3075d77d711798ddfa511a5391581aef83e1a8ebbf64f',
        schema: '44ebdf54404a4ee69016a24a6db2aded96b661997d655dc55e0e544111d66fed',
      },
      fingerprint: 'f00522fa18cac8f477f604e56c372b16d691199879b7d1ae2787fb1bf860429a',
    });
  });

  it('adds the requested commit form, with git-config unresolved and the default spelled out', async () => {
    await merge('golden');
    await merge('git-config', { message: 'Fix #42', author: 'git-config' });
    await merge('bare', { message: 'Fix #42' });
    await merge('explicit-default', { message: 'Fix #42', author: 'quiet-choir' });
    const plain = (await recorded('golden'))['integrate'];
    const configured = (await recorded('git-config'))['integrate'];
    expect(configured?.identity['kind']).toBe(plain?.identity['kind']);
    expect(configured?.identity['onError']).toBe(plain?.identity['onError']);
    expect(configured?.identity['schema']).toBe(plain?.identity['schema']);
    expect(Object.keys(configured?.identity ?? {}).sort()).toEqual(
      Object.keys(plain?.identity ?? {}).sort(),
    );
    expect(configured?.identity['input']).not.toBe(plain?.identity['input']);
    expect(configured?.fingerprint).not.toBe(plain?.fingerprint);
    // The author stays as requested: git config is read only when the merge is prepared.
    expect(configured?.identity['input']).toBe(
      digest({
        changes: [{ base: change.base, commit: change.commit }],
        strategy: 'squash',
        onConflict: 'report',
        target: { branch: 'agent/100' },
        commit: { message: 'Fix #42', author: 'git-config' },
      }),
    );
    const bare = (await recorded('bare'))['integrate'];
    expect(bare).toEqual((await recorded('explicit-default'))['integrate']);
    expect(bare?.fingerprint).not.toBe(configured?.fingerprint);
    expect(bare?.fingerprint).not.toBe(plain?.fingerprint);
  });
});

describe('idle deadline identity', () => {
  // idleTimeoutMs is execution policy like timeoutMs: it never enters a call's identity.
  it.each(['claude', 'codex'] as const)(
    'keeps %s identity unchanged by idleTimeoutMs',
    (harness) => {
      const identity = (extra: object) =>
        agentIdentity(
          { harness, cwd, outputSchema: null, options: { prompt: 'x', ...extra } },
          null,
        );
      expect(identity({ idleTimeoutMs: 1000 })).toEqual(identity({}));
      expect(identity({ idleTimeoutMs: 1000 })).toEqual(identity({ idleTimeoutMs: 9000 }));
    },
  );

  it('keeps a registered harness identity unchanged by idleTimeoutMs', () => {
    const identity = (extra: object, definition?: HarnessDeclaration) =>
      agentIdentity(
        {
          harness: 'tool',
          revision: 1,
          cwd,
          outputSchema: null,
          options: { prompt: 'x', ...extra },
        },
        null,
        definition,
      );
    expect(identity({ idleTimeoutMs: 1000 })).toEqual(identity({}));
    // A revised built-in contract takes the registered path, where its policy list applies.
    const revised = (extra: object) =>
      agentIdentity(
        {
          harness: 'claude',
          revision: 2,
          cwd,
          outputSchema: null,
          options: { prompt: 'x', ...extra },
        },
        null,
        claudeDefinition,
      );
    expect(revised({ idleTimeoutMs: 1000 })).toEqual(revised({}));
  });
});
