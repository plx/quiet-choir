import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as host from '../src/index.js';
import * as hostKit from '../src/harness-kit.js';
import type { ErrorKind, HarnessErrorDetails, RunRecord } from '../src/index.js';
import { harnessEvidence, type HarnessEvidence } from '../src/workflow/runtime/harness-error.js';
import { errorKind } from '../src/workflow/runtime/step-error.js';

// ADR 0028: `workflow execute` imports workflow code through tsx, which gives it a second copy of
// quiet-choir. A second module instance from vi.resetModules() reproduces that boundary.
type Api = typeof host;
type Kit = typeof hostKit;
let second: Api;
let secondKit: Kit;
beforeAll(async () => {
  vi.resetModules();
  second = await import('../src/index.js');
  secondKit = await import('../src/harness-kit.js');
});

const errorBrand = Symbol.for('quiet-choir.error');
const errorBrandName = Symbol.for('quiet-choir.error-name');

function rateLimited(overrides: Partial<HarnessErrorDetails> = {}): HarnessErrorDetails {
  return {
    harness: 'custom',
    exit: { code: 1, signal: null },
    failure: {
      reason: 'Rate limit reached',
      subtype: null,
      terminalReason: null,
      apiStatus: 429,
      sessionId: null,
      usage: null,
    },
    reason: 'rate limited',
    stderr: '',
    stdout: '',
    ...overrides,
  };
}

/** One instance of every public error class, built by the given module instance. */
function samples(api: Api): Record<string, Error> {
  const run = { id: 'run', rootCause: null, steps: {} } as unknown as RunRecord;
  return {
    HarnessError: new api.HarnessError(rateLimited()),
    ConfigurationError: new api.ConfigurationError('bad configuration'),
    ExecError: new api.ExecError('failed', 'process'),
    CancelledError: new api.CancelledError(null, undefined),
    FanOutError: new api.FanOutError('drain', [], []),
    RunBudgetExceededError: new api.RunBudgetExceededError('run', {
      stepId: 'step',
      metric: 'maxRunCostUsd',
      limit: 1,
      observed: 2,
      at: '2026-09-30T00:00:00.000Z',
    }),
    CheckpointError: new api.CheckpointError('save', 'disk full', undefined),
    RunRefusedError: new api.RunRefusedError('run.locked', 'run', 'locked'),
    OrphanProcessesError: new api.OrphanProcessesError('run', []),
    WorkflowRunError: new api.WorkflowRunError(run, new Error('boom')),
    WorkflowInputError: new api.WorkflowInputError(null, new Error('invalid')),
    AnswerError: new api.AnswerError('invalid', 'bad answer'),
  };
}

type Constructor = abstract new (...args: never[]) => unknown;

function errorClasses(...modules: object[]): Map<string, Constructor> {
  const classes = new Map<string, Constructor>();
  for (const module of modules)
    for (const value of Object.values(module) as unknown[])
      if (typeof value === 'function' && Reflect.get(value, 'prototype') instanceof Error)
        classes.set(value.name, value as Constructor);
  return classes;
}

function classOf(api: Api, name: string): Constructor {
  const value: unknown = Reflect.get(api, name);
  if (typeof value !== 'function') throw new Error(`${name} is not exported`);
  return value as Constructor;
}

const evidence: HarnessEvidence = {
  sessionId: 'sess-1',
  usage: null,
  diagnostics: { marker: 'x' },
  rawText: 'raw',
  responseTruncated: false,
};

describe('public error brands (ADR 0028)', () => {
  it('brands every Error class exported from the public entry points under its own name', () => {
    const classes = errorClasses(host, hostKit);
    expect([...classes.keys()].sort()).toEqual(Object.keys(samples(host)).sort());
    for (const [name, constructor] of classes) {
      expect(Object.hasOwn(constructor, errorBrandName), name).toBe(true);
      expect(Reflect.get(constructor, errorBrandName), name).toBe(name);
      const chain: unknown = Reflect.get(constructor.prototype as object, errorBrand);
      expect(Array.isArray(chain) && chain[0], name).toBe(name);
      expect(Object.isFrozen(chain), name).toBe(true);
      expect(Object.hasOwn(constructor, Symbol.hasInstance), name).toBe(true);
    }
  });

  it('respects the class hierarchy within one module instance', () => {
    const orphan = new host.OrphanProcessesError('run', []);
    const refused = new host.RunRefusedError('run.locked', 'run', 'locked');
    expect(orphan instanceof host.RunRefusedError).toBe(true);
    expect(refused instanceof host.OrphanProcessesError).toBe(false);
    expect(orphan instanceof Error).toBe(true);

    class Mine extends host.HarnessError {}
    const mine = new Mine(rateLimited());
    expect(mine instanceof host.HarnessError).toBe(true);
    expect(mine instanceof Mine).toBe(true);
    expect(new host.HarnessError(rateLimited()) instanceof Mine).toBe(false);
    expect(Object.hasOwn(Mine, errorBrandName)).toBe(false);

    for (const value of [null, undefined, 1, 'HarnessError', {}, new Error('plain')]) {
      expect(value instanceof host.HarnessError).toBe(false);
      expect(value instanceof host.ConfigurationError).toBe(false);
    }
    expect({ kind: 'rate-limit', name: 'HarnessError' } instanceof host.HarnessError).toBe(false);
  });

  it('recognizes instances across module instances in both directions, by class', () => {
    expect(second.HarnessError).not.toBe(host.HarnessError);
    expect(secondKit.HarnessError).toBe(second.HarnessError);
    const names = Object.keys(samples(host));
    for (const [builder, checker] of [
      [host, second],
      [second, host],
    ] as const) {
      const built = samples(builder);
      for (const name of names)
        for (const target of names) {
          const expected =
            name === target || (name === 'OrphanProcessesError' && target === 'RunRefusedError');
          expect(built[name] instanceof classOf(checker, target), `${name} vs ${target}`).toBe(
            expected,
          );
        }
    }
  });

  it('keeps plain prototype semantics for a user subclass across module instances', () => {
    class Mine extends host.HarnessError {}
    expect(new second.HarnessError(rateLimited()) instanceof Mine).toBe(false);
    expect(new Mine(rateLimited()) instanceof second.HarnessError).toBe(true);
    class Theirs extends second.OrphanProcessesError {}
    expect(new Theirs('run', []) instanceof host.RunRefusedError).toBe(true);
    expect(new host.OrphanProcessesError('run', []) instanceof Theirs).toBe(false);
  });

  it('classifies failures built by another module instance', () => {
    expect(errorKind(new secondKit.HarnessError(rateLimited()))).toBe('rate-limit');
    expect(errorKind(new second.ExecError('failed', 'timeout'))).toBe('timeout');
    expect(errorKind(new second.CancelledError(null, undefined))).toBe('cancelled');
  });

  it('trusts a branded kind only when it is a known error kind', () => {
    expect(errorKind(new second.ExecError('failed', 'future-kind' as ErrorKind))).toBe('unknown');
    expect(errorKind(new host.ExecError('failed', 'future-kind' as ErrorKind))).toBe('unknown');
    expect(errorKind(new secondKit.HarnessError(rateLimited({ kind: 'bogus' as ErrorKind })))).toBe(
      'unknown',
    );
  });

  it('reads adapter evidence attached by another module instance', () => {
    const error = new Error('adapter failed');
    secondKit.attachHarnessEvidence(error, evidence);
    expect(harnessEvidence(error)).toEqual(evidence);
    // A branded HarnessError's own fields win over attached evidence.
    const harness = new secondKit.HarnessError(rateLimited({ sessionId: 'own' }));
    hostKit.attachHarnessEvidence(harness, evidence);
    expect(harnessEvidence(harness)?.sessionId).toBe('own');
  });

  it('keeps brands and evidence out of enumeration and JSON', () => {
    const error = new host.ConfigurationError('bad configuration');
    const keys = Object.keys(error);
    const json = JSON.stringify(error);
    hostKit.attachHarnessEvidence(error, evidence);
    expect(Object.keys(error)).toEqual(keys);
    expect(JSON.stringify(error)).toBe(json);
    expect(Object.getOwnPropertySymbols(Object.assign({}, error))).toEqual([]);
    expect(Object.getOwnPropertySymbols(error)).not.toContain(errorBrand);
    expect(harnessEvidence(error)).toBe(evidence);
    // Attaching again replaces the evidence.
    const next = { ...evidence, sessionId: 'sess-2' };
    hostKit.attachHarnessEvidence(error, next);
    expect(harnessEvidence(error)).toBe(next);
  });

  it('keeps evidence for a frozen error within the same module instance', () => {
    const frozen = Object.freeze(new Error('frozen'));
    hostKit.attachHarnessEvidence(frozen, evidence);
    expect(harnessEvidence(frozen)).toBe(evidence);
    expect(Object.getOwnPropertySymbols(frozen)).toEqual([]);
    hostKit.attachHarnessEvidence('not an object', evidence);
    expect(harnessEvidence('not an object')).toBeUndefined();
    expect(harnessEvidence(new Error('none'))).toBeUndefined();
  });
});
