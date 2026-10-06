import { readdirSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commandLauncher,
  detectCommandLauncher,
  detectSpawnLauncher,
  processLauncherProbe,
  setCommandLauncher,
  setSpawnLauncher,
  spawnLauncher,
  type LauncherProbe,
} from '../src/cli/launcher.js';
import {
  defaultCommandLauncher,
  killOrphansArgv,
  launchPolicyFlags,
  workflowArgv,
} from '../src/workflow/runtime/commands.js';
import type { LaunchPolicy } from '../src/index.js';

const node = '/usr/local/bin/node';
const checkout = '/work/checkout/bin/run.js';
const other = '/work/other/bin/run.js';
/** Symlinks the injected realpath follows; any other existing path resolves to itself. */
const links: Record<string, string> = {
  '/usr/local/bin/quiet-choir': checkout,
  '/opt/other/bin/quiet-choir': other,
  '/work/project/node_modules/.bin/quiet-choir': checkout,
  '/dangling/quiet-choir': '/missing',
};
const existing = new Set([checkout, other, ...Object.keys(links)]);

function probe(overrides: Partial<LauncherProbe>): LauncherProbe {
  return {
    argv1: checkout,
    execPath: node,
    execArgv: ['--import', 'tsx'],
    development: false,
    pathEnv: ['/usr/bin', '/bin'].join(delimiter),
    realpath: (path) => {
      const target = links[path] ?? path;
      if (!existing.has(path) || (target !== path && !existing.has(target)))
        throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return target;
    },
    isExecutable: (path) => existing.has(path),
    ...overrides,
  };
}

describe('detectCommandLauncher', () => {
  it.each<[string, Partial<LauncherProbe>, readonly string[]]>([
    ['a checkout run directly as bin/run.js', {}, [node, checkout]],
    [
      'an installed bin on PATH that resolves to this script',
      {
        argv1: '/usr/local/bin/quiet-choir',
        pathEnv: ['/usr/bin', '/usr/local/bin'].join(delimiter),
      },
      ['quiet-choir'],
    ],
    [
      'an npx or npm-run shim that only node_modules/.bin puts on PATH',
      {
        argv1: '/work/project/node_modules/.bin/quiet-choir',
        pathEnv: ['/work/project/node_modules/.bin', '/usr/bin'].join(delimiter),
      },
      [node, checkout],
    ],
    [
      'a PATH quiet-choir that belongs to a different checkout',
      {
        argv1: '/usr/local/bin/quiet-choir',
        pathEnv: ['/opt/other/bin', '/usr/local/bin'].join(delimiter),
      },
      [node, checkout],
    ],
    [
      'a dangling PATH quiet-choir',
      { argv1: '/usr/local/bin/quiet-choir', pathEnv: '/dangling' },
      [node, checkout],
    ],
    [
      'a bin named quiet-choir with no PATH at all',
      { argv1: '/usr/local/bin/quiet-choir', pathEnv: undefined },
      [node, checkout],
    ],
    [
      'development mode, keeping the loader flags',
      { development: true },
      [node, '--import', 'tsx', checkout],
    ],
    ['a missing argv[1]', { argv1: undefined }, defaultCommandLauncher],
    ['an unresolvable argv[1]', { argv1: '/nowhere/run.js' }, defaultCommandLauncher],
  ])('%s', (_label, overrides, expected) => {
    expect(detectCommandLauncher(probe(overrides))).toEqual(expected);
  });

  it('probes the real process: this test runner is not an installed quiet-choir', () => {
    const real = processLauncherProbe(false);
    expect(real.execPath).toBe(process.execPath);
    expect(real.isExecutable(process.execPath)).toBe(true);
    expect(real.isExecutable('/')).toBe(false);
    expect(real.isExecutable('/definitely/not/here')).toBe(false);
    const launcher = detectCommandLauncher(real);
    expect(launcher[0]).toBe(process.execPath);
  });
});

describe('detectSpawnLauncher', () => {
  // A spawned child must be Node itself running the real script: never the PATH word, so the
  // child PID is the runner's PID and no PATH lookup is needed.
  it.each<[string, Partial<LauncherProbe>, readonly string[] | undefined]>([
    ['a checkout run directly as bin/run.js', {}, [node, checkout]],
    [
      'an installed bin on PATH that resolves to this script',
      {
        argv1: '/usr/local/bin/quiet-choir',
        pathEnv: ['/usr/bin', '/usr/local/bin'].join(delimiter),
      },
      [node, checkout],
    ],
    [
      'an npx or npm-run shim',
      {
        argv1: '/work/project/node_modules/.bin/quiet-choir',
        pathEnv: ['/work/project/node_modules/.bin', '/usr/bin'].join(delimiter),
      },
      [node, checkout],
    ],
    [
      'development mode, keeping the loader flags',
      { development: true },
      [node, '--import', 'tsx', checkout],
    ],
    ['a missing argv[1]', { argv1: undefined }, undefined],
    ['an unresolvable argv[1]', { argv1: '/nowhere/run.js' }, undefined],
  ])('%s', (_label, overrides, expected) => {
    expect(detectSpawnLauncher(probe(overrides))).toEqual(expected);
  });

  it('is shared with a second module instance through a registered global symbol', () => {
    // Development mode loads command modules as another instance of launcher.ts.
    const shared = (
      globalThis as unknown as Record<symbol, { spawn?: unknown; command?: unknown }>
    )[Symbol.for('quiet-choir.cli.launchers')];
    try {
      setSpawnLauncher([node, checkout]);
      setCommandLauncher([node, checkout]);
      const state = (
        globalThis as unknown as Record<symbol, { spawn?: unknown; command?: unknown }>
      )[Symbol.for('quiet-choir.cli.launchers')];
      expect(state).toEqual({ spawn: [node, checkout], command: [node, checkout] });
      expect(shared === undefined || shared === state).toBe(true);
    } finally {
      setSpawnLauncher(undefined);
      setCommandLauncher(undefined);
    }
  });

  it('is recorded separately from the command launcher', () => {
    try {
      expect(spawnLauncher()).toBeUndefined();
      setSpawnLauncher([node, checkout]);
      expect(spawnLauncher()).toEqual([node, checkout]);
      expect(commandLauncher()).toBeUndefined();
    } finally {
      setSpawnLauncher(undefined);
    }
  });
});

describe('command launcher state', () => {
  afterEach(() => {
    setCommandLauncher(undefined);
  });

  it('defaults to undefined, which the runtime renders as quiet-choir', () => {
    expect(commandLauncher()).toBeUndefined();
    expect(workflowArgv(commandLauncher(), 'resume', 'r')).toEqual([
      'quiet-choir',
      'workflow',
      'resume',
      'r',
    ]);
  });

  it('prefixes emitted argv with a recorded launcher; an empty one falls back', () => {
    setCommandLauncher([node, checkout]);
    expect(workflowArgv(commandLauncher(), 'inspect', 'r')).toEqual([
      node,
      checkout,
      'workflow',
      'inspect',
      'r',
    ]);
    expect(workflowArgv([], 'inspect', 'r')).toEqual(['quiet-choir', 'workflow', 'inspect', 'r']);
  });
});

describe('launchPolicyFlags', () => {
  const digest = 'a'.repeat(64);
  const launch = (policy?: LaunchPolicy) => ({
    entrypoint: '/w.ts',
    tsconfig: null,
    ...(policy === undefined ? {} : { policy }),
  });
  it.each<[string, LaunchPolicy | undefined, readonly string[]]>([
    ['no policy (an older record or an embedder launch)', undefined, []],
    ['the defaults, cli and suspend', { harness: { kind: 'cli' }, waitMode: 'suspend' }, []],
    [
      'a global fixture',
      {
        harness: { kind: 'fixture', fixtures: [{ path: '/p/f.json', sha256: digest }] },
        waitMode: 'suspend',
      },
      ['--harness', 'fixture:/p/f.json'],
    ],
    [
      'named fixtures under cli',
      {
        harness: {
          kind: 'cli',
          fixtures: [
            { name: 'third', path: '/p/t.json', sha256: digest },
            { name: 'fourth', path: '/p/u.json', sha256: digest },
          ],
        },
        waitMode: 'suspend',
      },
      ['--harness', 'third=fixture:/p/t.json', '--harness', 'fourth=fixture:/p/u.json'],
    ],
    ['block', { harness: { kind: 'cli' }, waitMode: 'block' }, ['--wait-mode', 'block']],
    [
      'worktree keep only',
      { harness: { kind: 'cli' }, waitMode: 'suspend', worktrees: { keep: 'all' } },
      ['--worktree-keep', 'all'],
    ],
    [
      'worktree keep and root after the wait mode',
      {
        harness: { kind: 'cli' },
        waitMode: 'block',
        worktrees: { keep: 'none', root: '/p/caches' },
      },
      ['--wait-mode', 'block', '--worktree-keep', 'none', '--worktree-root', '/p/caches'],
    ],
    [
      'everything, unnamed fixture first',
      {
        harness: {
          kind: 'fixture',
          fixtures: [
            { name: 'third', path: '/p/t.json', sha256: digest },
            { path: '/p/f.json', sha256: digest },
          ],
        },
        waitMode: 'block',
      },
      [
        '--harness',
        'fixture:/p/f.json',
        '--harness',
        'third=fixture:/p/t.json',
        '--wait-mode',
        'block',
      ],
    ],
  ])('%s', (_label, policy, expected) => {
    expect(launchPolicyFlags(launch(policy))).toEqual(expected);
  });

  it('adds nothing without a launch', () => {
    expect(launchPolicyFlags(undefined)).toEqual([]);
  });
});

describe('killOrphansArgv', () => {
  it('spells resume --kill-orphans behind the default launcher with an absolute state directory', () => {
    expect(killOrphansArgv(undefined, '/state', 'r1')).toEqual([
      'quiet-choir',
      'workflow',
      'resume',
      'r1',
      '--state-dir',
      '/state',
      '--kill-orphans',
    ]);
    expect(killOrphansArgv(undefined, 'rel', 'r1')).toContain(resolve('rel'));
  });

  it('starts with a custom launcher', () => {
    expect(killOrphansArgv(['/x/node', '/y/run.js'], '/state', 'r1')).toEqual([
      '/x/node',
      '/y/run.js',
      'workflow',
      'resume',
      'r1',
      '--state-dir',
      '/state',
      '--kill-orphans',
    ]);
  });
});

describe('runtime prose hints', () => {
  /** Every non-comment source line that spells a workflow command with a hard-coded program word. */
  it('never hard-codes the program word before a workflow command in src/', () => {
    const source = fileURLToPath(new URL('../src', import.meta.url));
    const files = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(directory, entry.name))
          : entry.name.endsWith('.ts')
            ? [join(directory, entry.name)]
            : [],
      );
    const offenders = files(source).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line, number: index + 1 }))
        .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/u.test(line))
        .filter(({ line }) => line.includes('quiet-choir workflow '))
        .map(({ file, number }) => `${file}:${String(number)}`),
    );
    expect(offenders).toEqual([]);
  });
});
