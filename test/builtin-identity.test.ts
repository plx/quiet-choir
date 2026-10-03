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
