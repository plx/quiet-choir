import { describe, expect, it } from 'vitest';

import {
  groupLaunchFiles,
  inFlightLeftoverMessage,
  inFlightUnreadableMessage,
  isLoneLaunchDirectory,
  judgeLaunch,
  launchSettleFloorMs,
  leftoverRemovable,
  parseRunnerIdentity,
  sameLaunchLog,
  type LaunchEntry,
  type LaunchLogIdentity,
  type RunnerLiveness,
} from '../src/workflow/runtime/launch-leftover-decision.js';

const file = (name: string): LaunchEntry => ({ name, kind: 'file' });
const directory = (name: string): LaunchEntry => ({ name, kind: 'directory' });
const runner = (value: object): string => JSON.stringify(value);
const identity = { pid: 42, host: 'here', osStartTime: null };
const log: LaunchLogIdentity = {
  dev: '16777234',
  ino: '18446744073709551557',
  birthtimeNs: '1760918400123456789',
};
const bound = { ...identity, log };

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

  it('leaves out every other entry with ignoreOthers, as a damaged run’s judgement needs', () => {
    expect(
      groupLaunchFiles(
        [
          file('1.log'),
          file('notes.txt'),
          file('0.log'),
          file('1.json'),
          directory('2.log'),
          { name: '3.log', kind: 'other' },
          file('1.runner.json'),
        ],
        { ignoreOthers: true },
      ),
    ).toEqual([{ n: 1, files: ['1.log', '1.runner.json'] }]);
    expect(groupLaunchFiles([file('notes.txt')], { ignoreOthers: true })).toEqual([]);
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

  it('parses a record bound to its log, and an unbound one from an older build', () => {
    // 64-bit device and inode numbers survive as decimal strings.
    expect(parseRunnerIdentity(runner(bound))).toEqual(bound);
    expect(parseRunnerIdentity('{"pid":42,"host":"here","osStartTime":null}\n')).toEqual(identity);
    expect(
      parseRunnerIdentity(runner({ ...identity, log: { dev: '1', ino: '2', birthtimeNs: '0' } })),
    ).toEqual({ ...identity, log: { dev: '1', ino: '2', birthtimeNs: '0' } });
  });

  it.for([
    ['a non-digit string', { ...log, ino: '12a' }],
    ['a negative number string', { ...log, dev: '-1' }],
    ['an empty string', { ...log, birthtimeNs: '' }],
    ['a missing ino', { dev: log.dev, birthtimeNs: log.birthtimeNs }],
    ['a number instead of a string', { ...log, ino: 12 }],
    ['null', null],
  ] as const)('rejects a log binding with %s', ([, binding]) => {
    expect(parseRunnerIdentity(runner({ ...identity, log: binding }))).toBeNull();
  });

  it('compares log identities by dev, inode and birth time', () => {
    expect(sameLaunchLog(log, { ...log })).toBe(true);
    for (const key of ['dev', 'ino', 'birthtimeNs'] as const)
      expect(sameLaunchLog(log, { ...log, [key]: '7' })).toBe(false);
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
        judgeLaunch({ n: 3, runnerText: runner(identity), newestMtimeMs, log }, context(state)),
      ).toEqual({ n: 3, state: expected, runner: state, pid: 42, host: 'here' });
  });

  it('an unparsable runner record is in flight even when old, and reads no liveness', () => {
    let read = false;
    expect(
      judgeLaunch(
        { n: 1, runnerText: '{"pid":', newestMtimeMs: 0, log },
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

  it.for([
    ['another device', { ...log, dev: '16777235' }],
    ['another inode', { ...log, ino: '18446744073709551556' }],
    ['another birth time, as for a reused inode', { ...log, birthtimeNs: '1760918400123456790' }],
    ['no current log', null],
  ] as const)(
    'a record bound to %s is unparsable even with a dead runner and old files, reading no liveness',
    ([, current]) => {
      let read = false;
      expect(
        judgeLaunch(
          { n: 2, runnerText: runner(bound), newestMtimeMs: 0, log: current },
          {
            nowMs: now,
            floorMs: launchSettleFloorMs,
            liveness: () => {
              read = true;
              return 'dead';
            },
          },
        ),
      ).toEqual({ n: 2, state: 'in-flight', runner: 'unparsable', pid: null, host: null });
      expect(read).toBe(false);
    },
  );

  it('a record bound to the current log follows its runner', () => {
    const judge = (state: RunnerLiveness) =>
      judgeLaunch(
        { n: 1, runnerText: runner(bound), newestMtimeMs: now, log: { ...log } },
        context(state),
      );
    expect(judge('dead')).toEqual({
      n: 1,
      state: 'settled',
      runner: 'dead',
      pid: 42,
      host: 'here',
    });
    expect(judge('alive')).toMatchObject({ state: 'in-flight', runner: 'alive' });
  });

  it('an unbound record from an older build follows its runner whatever the log', () => {
    for (const current of [log, null])
      expect(
        judgeLaunch(
          { n: 1, runnerText: runner(identity), newestMtimeMs: 0, log: current },
          context('dead'),
        ),
      ).toEqual({ n: 1, state: 'settled', runner: 'dead', pid: 42, host: 'here' });
  });

  it('without a runner record, settles only once the newest file is older than the floor', () => {
    const judge = (age: number) =>
      judgeLaunch({ n: 1, runnerText: null, newestMtimeMs: now - age, log }, context('alive'))
        .state;
    expect(judge(0)).toBe('in-flight');
    expect(judge(launchSettleFloorMs)).toBe('in-flight');
    expect(judge(launchSettleFloorMs + 1)).toBe('settled');
  });

  it('one launch in flight keeps the whole leftover in flight', () => {
    const settled = judgeLaunch(
      { n: 1, runnerText: runner(identity), newestMtimeMs: 0, log },
      context('dead'),
    );
    const flying = judgeLaunch(
      { n: 2, runnerText: null, newestMtimeMs: now, log: null },
      context('dead'),
    );
    const empty = { directoryMtimeMs: now, nowMs: now, floorMs: launchSettleFloorMs };
    expect(leftoverRemovable([settled], empty)).toBe(true);
    expect(leftoverRemovable([settled, flying], empty)).toBe(false);
    const message = inFlightLeftoverMessage('broken', [settled, flying]);
    expect(message).toContain('launch 2: no runner record');
    expect(message).not.toContain('launch 1');
    expect(message).toContain('even with --force');
    const unreadable = inFlightUnreadableMessage('damaged', [settled, flying]);
    expect(unreadable).toContain('has an unreadable record');
    expect(unreadable).toContain('launch 2: no runner record');
    expect(unreadable).not.toContain('launch 1');
    expect(unreadable).toContain('even with --force');
    expect(inFlightUnreadableMessage('damaged', [])).toContain('changed while rm inspected it');
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
