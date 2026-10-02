import { describe, expect, it } from 'vitest';

import { executeFlags } from '../src/cli/execute-flags.js';
import { buildStartChildArgv, type ArgvFlagTable } from '../src/cli/start-argv.js';
import WorkflowStart from '../src/commands/workflow/start.js';
import { BaseCommand } from '../src/cli/base-command.js';

// The child-argv builder as a pure table: start's raw argv in, the runner's execute argv out.
const table: ArgvFlagTable = {
  json: { type: 'boolean' },
  'start-timeout': { type: 'option' },
  input: { type: 'option' },
  'run-id': { type: 'option' },
  'state-dir': { type: 'option' },
  harness: { type: 'option' },
  'harness-limit': { type: 'option', aliases: ['provider-limit'] },
  progress: { type: 'boolean' },
  verbose: { type: 'boolean', char: 'v' },
  'log-level': { type: 'option', char: 'l' },
  events: { type: 'option' },
};
const ids = { runId: 'gen', stateDir: '/state' };
const tail = ['--run-id', 'gen', '--state-dir', '/state', '--json'];

describe('buildStartChildArgv', () => {
  it.each<[string, string[], string[], number | null]>([
    ['appends run ID, state directory and --json', ['wf.ts'], ['wf.ts', ...tail], null],
    ['strips --json', ['wf.ts', '--json'], ['wf.ts', ...tail], null],
    ['strips --json=value', ['wf.ts', '--json=true'], ['wf.ts', ...tail], null],
    [
      'strips --start-timeout and its value',
      ['--start-timeout', '5s', 'wf.ts'],
      ['wf.ts', ...tail],
      null,
    ],
    ['strips --start-timeout=value', ['wf.ts', '--start-timeout=5s'], ['wf.ts', ...tail], null],
    [
      'keeps a given --run-id and appends only the state directory',
      ['wf.ts', '--run-id', 'x'],
      ['wf.ts', '--run-id', 'x', '--state-dir', '/state', '--json'],
      null,
    ],
    [
      'keeps --run-id=value and --state-dir=value spellings and appends neither',
      ['wf.ts', '--run-id=x', '--state-dir=rel'],
      ['wf.ts', '--run-id=x', '--state-dir=rel', '--json'],
      null,
    ],
    [
      'treats a flag-looking value of a value-taking flag as the value',
      ['wf.ts', '--input', '--json'],
      ['wf.ts', '--input', '--json', ...tail],
      null,
    ],
    [
      'keeps the alias spelling of a value-taking flag',
      ['wf.ts', '--provider-limit', 'codex=1'],
      ['wf.ts', '--provider-limit', 'codex=1', ...tail],
      null,
    ],
    [
      'keeps repeated multiple flags in order',
      ['wf.ts', '--harness', 'fixture:a.json', '--harness', 'claude=fixture:b.json'],
      ['wf.ts', '--harness', 'fixture:a.json', '--harness', 'claude=fixture:b.json', ...tail],
      null,
    ],
    [
      'keeps booleans without consuming the next token',
      ['--progress', 'wf.ts', '-v'],
      ['--progress', 'wf.ts', '-v', ...tail],
      null,
    ],
    [
      'keeps a short value-taking flag with its value',
      ['-l', 'debug', 'wf.ts'],
      ['-l', 'debug', 'wf.ts', ...tail],
      null,
    ],
    [
      'normalizes --input - and reports the index of -',
      ['wf.ts', '--input', '-'],
      ['wf.ts', '--input', '-', ...tail],
      2,
    ],
    [
      'normalizes --input=- to two tokens',
      ['wf.ts', '--input=-', '--progress'],
      ['wf.ts', '--input', '-', '--progress', ...tail],
      2,
    ],
    [
      'leaves other input forms alone',
      ['wf.ts', '--input=@in.json'],
      ['wf.ts', '--input=@in.json', ...tail],
      null,
    ],
    [
      'appends before a literal -- and keeps everything after it verbatim',
      ['wf.ts', '--', '--json', '--run-id', 'y'],
      ['wf.ts', ...tail, '--', '--json', '--run-id', 'y'],
      null,
    ],
    [
      'passes --events FILE through to the runner unchanged',
      ['wf.ts', '--events', 'run.events.jsonl'],
      ['wf.ts', '--events', 'run.events.jsonl', ...tail],
      null,
    ],
    [
      'passes --events=FILE through to the runner unchanged',
      ['wf.ts', '--events=/abs/run.events.jsonl', '--progress'],
      ['wf.ts', '--events=/abs/run.events.jsonl', '--progress', ...tail],
      null,
    ],
    [
      'passes unknown tokens through',
      ['wf.ts', '--unknown', 'value'],
      ['wf.ts', '--unknown', 'value', ...tail],
      null,
    ],
    [
      'keeps a value-taking flag without a value at the end',
      ['wf.ts', '--harness'],
      ['wf.ts', '--harness', ...tail],
      null,
    ],
  ])('%s', (_label, argv, args, stdinInputIndex) => {
    expect(buildStartChildArgv(argv, table, ids)).toEqual({ args, stdinInputIndex });
  });

  it('reads value-taking and boolean flags from the real start and execute tables', () => {
    const flags: ArgvFlagTable = { ...BaseCommand.baseFlags, ...WorkflowStart.flags };
    // Every start flag is an execute flag except start's own two, so new execute flags reach start.
    expect(Object.keys(WorkflowStart.flags).filter((name) => !(name in executeFlags))).toEqual([
      'start-timeout',
    ]);
    expect(flags['input']?.type).toBe('option');
    expect(flags['progress']?.type).toBe('boolean');
    expect(flags['events']?.type).toBe('option');
    expect(flags['harness-limit']?.aliases).toContain('provider-limit');
    expect(
      buildStartChildArgv(
        ['wf.ts', '--provider-limit', 'codex=1', '--progress', '-v', '--start-timeout', '1s'],
        flags,
        ids,
      ).args,
    ).toEqual(['wf.ts', '--provider-limit', 'codex=1', '--progress', '-v', ...tail]);
  });
});
