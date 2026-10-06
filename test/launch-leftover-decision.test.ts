import { describe, expect, it } from 'vitest';

import {
  groupLaunchFiles,
  inFlightLeftoverMessage,
  isLoneLaunchDirectory,
  judgeLaunch,
  launchSettleFloorMs,
  leftoverRemovable,
  parseRunnerIdentity,
  type LaunchEntry,
  type RunnerLiveness,
} from '../src/workflow/runtime/launch-leftover-decision.js';

const file = (name: string): LaunchEntry => ({ name, kind: 'file' });
const directory = (name: string): LaunchEntry => ({ name, kind: 'directory' });
const runner = (value: object): string => JSON.stringify(value);
const identity = { pid: 42, host: 'here', osStartTime: null };

describe('leftover launch directory shape', () => {
  it('accepts only a lone launch/ directory', () => {
    expect(isLoneLaunchDirectory([directory('launch')])).toBe(true);
    expect(isLoneLaunchDirectory([])).toBe(false);
    expect(isLoneLaunchDirectory([file('launch')])).toBe(false);
    expect(isLoneLaunchDirectory([{ name: 'launch', kind: 'other' }])).toBe(false);
    expect(isLoneLaunchDirectory([directory('launch'), directory('lock')])).toBe(false);
    expect(isLoneLaunchDirectory([directory('launch'), file('journal.jsonl')])).toBe(false);
    expect(isLoneLaunchDirectory([directory('inbox')])).toBe(false);
  });

  it('groups numbered log, result, input and runner files by launch number', () => {
    expect(
      groupLaunchFiles([
        file('2.log'),
        file('1.runner.json'),
        file('1.result.json'),
        file('10.log'),
        file('1.log'),
        file('1.input.json'),
      ]),
    ).toEqual([
      { n: 1, files: ['1.input.json', '1.log', '1.result.json', '1.runner.json'] },
      { n: 2, files: ['2.log'] },
      { n: 10, files: ['10.log'] },
    ]);
    expect(groupLaunchFiles([])).toEqual([]);
  });

  it.for([
    ['an unknown file', [file('1.log'), file('notes.txt')]],
    ['launch number 0', [file('0.log')]],
    ['a leading zero', [file('01.log')]],
    ['an old result name', [file('1.json')]],
    ['a directory named like a log', [directory('1.log')]],
    ['a symbolic link', [{ name: '1.log', kind: 'other' }]],
    ['a temporary file', [file('1.runner.json.tmp')]],
  ] as const)('rejects %s', ([, entries]) => {
    expect(groupLaunchFiles(entries)).toBeNull();
  });
});

describe('runner records', () => {
  it('parses a complete record and rejects anything else', () => {
    expect(parseRunnerIdentity(runner(identity))).toEqual(identity);
    expect(parseRunnerIdentity(runner({ ...identity, osStartTime: 'darwin:x' }))).toEqual({
      ...identity,
      osStartTime: 'darwin:x',
    });
    for (const text of [
      '',
      '{',
      'null',
      runner({ pid: 0, host: 'here', osStartTime: null }),
      runner({ pid: 1.5, host: 'here', osStartTime: null }),
      runner({ pid: 42, osStartTime: null }),
      runner({ pid: 42, host: 'here' }),
    ])
      expect(parseRunnerIdentity(text)).toBeNull();
  });
});

describe('judging a launch', () => {
  const now = 10 * launchSettleFloorMs;
  const context = (state: RunnerLiveness) => ({
    nowMs: now,
    floorMs: launchSettleFloorMs,
    liveness: () => state,
  });

  it.for([
    ['dead', 'settled'],
    ['alive', 'in-flight'],
    ['unknown', 'in-flight'],
    ['remote', 'in-flight'],
  ] as const)('a recorded runner that is %s is %s, whatever its age', ([state, expected]) => {
    for (const newestMtimeMs of [0, now])
      expect(
        judgeLaunch({ n: 3, runnerText: runner(identity), newestMtimeMs }, context(state)),
      ).toEqual({ n: 3, state: expected, runner: state, pid: 42, host: 'here' });
  });

  it('an unparsable runner record is in flight even when old, and reads no liveness', () => {
    let read = false;
    expect(
      judgeLaunch(
        { n: 1, runnerText: '{"pid":', newestMtimeMs: 0 },
        {
          nowMs: now,
          floorMs: launchSettleFloorMs,
          liveness: () => {
            read = true;
            return 'dead';
          },
        },
      ),
    ).toEqual({ n: 1, state: 'in-flight', runner: 'unparsable', pid: null, host: null });
    expect(read).toBe(false);
  });

  it('without a runner record, settles only once the newest file is older than the floor', () => {
    const judge = (age: number) =>
      judgeLaunch({ n: 1, runnerText: null, newestMtimeMs: now - age }, context('alive')).state;
    expect(judge(0)).toBe('in-flight');
    expect(judge(launchSettleFloorMs)).toBe('in-flight');
    expect(judge(launchSettleFloorMs + 1)).toBe('settled');
  });

  it('one launch in flight keeps the whole leftover in flight', () => {
    const settled = judgeLaunch(
      { n: 1, runnerText: runner(identity), newestMtimeMs: 0 },
      context('dead'),
    );
    const flying = judgeLaunch({ n: 2, runnerText: null, newestMtimeMs: now }, context('dead'));
    const empty = { directoryMtimeMs: now, nowMs: now, floorMs: launchSettleFloorMs };
    expect(leftoverRemovable([settled], empty)).toBe(true);
    expect(leftoverRemovable([settled, flying], empty)).toBe(false);
    const message = inFlightLeftoverMessage('broken', [settled, flying]);
    expect(message).toContain('launch 2: no runner record');
    expect(message).not.toContain('launch 1');
    expect(message).toContain('even with --force');
  });

  it('judges an empty launch/ by its own age', () => {
    const at = (age: number) => ({
      directoryMtimeMs: now - age,
      nowMs: now,
      floorMs: launchSettleFloorMs,
    });
    expect(leftoverRemovable([], at(0))).toBe(false);
    expect(leftoverRemovable([], at(launchSettleFloorMs + 1))).toBe(true);
  });
});
