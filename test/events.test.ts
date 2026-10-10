import type * as NodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionLogger } from '../src/application/execution.js';
import { requestedEventsStdout, requestedJson } from '../src/cli/workflow-errors.js';
import {
  EVENT_LINE_MAX_BYTES,
  EventLineMemory,
  eventLineTypes,
  formatEventLine,
  WorkflowEventLog,
  type EventLine,
} from '../src/workflow/loader/events.js';
import type { WorkflowEvent } from '../src/workflow/runtime/runner.js';
import { formatEventFields } from '../src/workflow/loader/event-line.js';
import { recordEventLines } from '../src/workflow/loader/event-follow.js';
import type { AttemptRecord, RunRecord } from '../src/workflow/runtime/record.js';
import { eventLogEntry, WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import type { AgentUsage } from '../src/workflow/runtime/model.js';

// Fail the sink's file writes on demand; every other fs call stays real.
const fsControl = vi.hoisted(() => ({ failWrites: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (fsControl.failWrites)
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
        });
      return actual.writeSync(...args);
    },
  };
});

const at = (ms: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, 0, ms)).toISOString();

function event(fields: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'type'>): WorkflowEvent {
  return {
    at: at(0),
    execution: 1,
    runId: 'r1',
    attempt: 1,
    stepId: 'step',
    ...fields,
  } as WorkflowEvent;
}

function line(input: WorkflowEvent, memory = new EventLineMemory()): EventLine | null {
  const text = formatEventLine(input, memory);
  return text === null ? null : (JSON.parse(text) as EventLine);
}

describe('formatEventLine', () => {
  it.each(eventLineTypes)('writes %s', (type) => {
    expect(line(event({ type }))?.ev).toBe(type);
  });

  it.each([
    'step.started',
    'step.waiting',
    'step.replayed',
    'step.cancelled',
    'step.redefined',
    'step.superseded',
    'step.reused',
    'replay.divergence',
    'agent.queued',
    'agent.admitted',
    'agent.started',
    'agent.progress',
    'agent.finished',
    'child.started',
    'child.redefined',
    'child.completed',
    'child.failed',
    'child.settled',
    'child.superseded',
  ] as const)('drops %s', (type) => {
    expect(formatEventLine(event({ type }), new EventLineMemory())).toBeNull();
  });

  it.each(eventLineTypes)('drops a replayed %s echo', (type) => {
    expect(formatEventLine(event({ type, replayed: true }), new EventLineMemory())).toBeNull();
  });

  it('keeps the field order and omits absent fields', () => {
    expect(
      formatEventLine(
        event({ type: 'run.completed', stepId: null, message: '', phase: null }),
        new EventLineMemory(),
      ),
    ).toBe(`{"t":"${at(0)}","run":"r1","ev":"run.completed"}`);
    const memory = new EventLineMemory();
    memory.observe(event({ type: 'step.started', stepId: 'a', at: at(0) }));
    expect(
      formatEventLine(
        event({
          type: 'step.failed',
          stepId: 'a',
          attempt: 2,
          harness: 'codex',
          at: at(40),
          phase: 'review',
          error: 'boom',
          usage: { inputTokens: null, outputTokens: null, costUsd: 0.5 },
        }),
        memory,
      ),
    ).toBe(
      `{"t":"${at(40)}","run":"r1","ev":"step.failed","step":"a","attempt":2,"errorKind":null,"retryable":false,"harness":"codex","ms":40,"costUsd":0.5,"phase":"review","msg":"boom"}`,
    );
  });

  it('puts attempt only on step.failed and step.settled', () => {
    expect(line(event({ type: 'step.settled', attempt: 3 }))?.attempt).toBe(3);
    expect(line(event({ type: 'step.completed', attempt: 3 }))).not.toHaveProperty('attempt');
    expect(line(event({ type: 'wait.opened', attempt: 3 }))).not.toHaveProperty('attempt');
  });

  it('writes errorKind and retryable after attempt on step.failed, null when none was recorded', () => {
    expect(
      formatEventLine(
        event({ type: 'step.failed', attempt: 2, errorKind: 'rate-limit', error: 'slow down' }),
        new EventLineMemory(),
      ),
    ).toBe(
      `{"t":"${at(0)}","run":"r1","ev":"step.failed","step":"step","attempt":2,"errorKind":"rate-limit","retryable":true,"msg":"slow down"}`,
    );
    expect(line(event({ type: 'step.failed', errorKind: 'schema' }))).toMatchObject({
      errorKind: 'schema',
      retryable: false,
    });
    const none = formatEventLine(event({ type: 'step.failed' }), new EventLineMemory()) ?? '';
    expect(none).toContain('"errorKind":null,"retryable":false');
    expect(line(event({ type: 'step.failed', errorKind: null }))).toMatchObject({
      errorKind: null,
      retryable: false,
    });
  });

  it('writes the pair on run.failed only when it names a root effect and a kind', () => {
    expect(line(event({ type: 'run.failed', errorKind: 'timeout' }))).toMatchObject({
      errorKind: 'timeout',
      retryable: true,
    });
    expect(line(event({ type: 'run.failed', errorKind: null }))).toMatchObject({
      errorKind: null,
      retryable: false,
    });
    const body = line(event({ type: 'run.failed', stepId: null }));
    expect(body).not.toHaveProperty('errorKind');
    expect(body).not.toHaveProperty('retryable');
    const bare = line(event({ type: 'run.failed' }));
    expect(bare).not.toHaveProperty('errorKind');
    expect(bare).not.toHaveProperty('retryable');
  });

  it('keeps the pair off every other event even when given a kind', () => {
    for (const type of ['step.settled', 'step.completed', 'log', 'run.cancelled'] as const) {
      const parsed = line(event({ type, errorKind: 'rate-limit' }));
      expect(parsed).not.toHaveProperty('errorKind');
      expect(parsed).not.toHaveProperty('retryable');
    }
  });

  it('writes the step error as msg on step.failed and step.settled only', () => {
    expect(line(event({ type: 'step.failed', error: 'boom' }))?.msg).toBe('boom');
    expect(line(event({ type: 'step.settled', error: 'boom' }))?.msg).toBe('boom');
    expect(line(event({ type: 'step.failed' }))).not.toHaveProperty('msg');
    // The replay-divergence style message is never taken for a step failure.
    expect(line(event({ type: 'step.failed', message: 'other' }))).not.toHaveProperty('msg');
    expect(line(event({ type: 'step.completed', error: 'boom' }))).not.toHaveProperty('msg');
    expect(
      formatEventLine(event({ type: 'step.cancelled', error: 'boom' }), new EventLineMemory()),
    ).toBeNull();
  });

  it('keeps a line with an oversized step error within the byte cap', () => {
    const text = formatEventLine(
      event({ type: 'step.failed', stepId: 'a/'.repeat(80), error: 'e'.repeat(500) }),
      new EventLineMemory(),
    );
    expect(Buffer.byteLength(text ?? '')).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
    expect(JSON.parse(text ?? '')).toHaveProperty('msg');
  });

  it('keeps errorKind and retryable when an oversized step.failed line is cut to the byte cap', () => {
    const text =
      formatEventLine(
        event({
          type: 'step.failed',
          stepId: 'a/'.repeat(300),
          phase: 'p'.repeat(300),
          error: 'e'.repeat(500),
          errorKind: 'idle-timeout',
        }),
        new EventLineMemory(),
      ) ?? '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
    expect(JSON.parse(text)).toMatchObject({ errorKind: 'idle-timeout', retryable: true });
  });

  it('takes costUsd from usage and omits a null or missing cost', () => {
    const usage = (costUsd: number | null): AgentUsage => ({
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
    });
    expect(line(event({ type: 'step.completed', usage: usage(0.25) }))?.costUsd).toBe(0.25);
    expect(line(event({ type: 'step.completed', usage: usage(null) }))).not.toHaveProperty(
      'costUsd',
    );
    expect(line(event({ type: 'step.completed' }))).not.toHaveProperty('costUsd');
  });

  it('carries the harness over from agent events of the same run and step', () => {
    const memory = new EventLineMemory();
    expect(
      formatEventLine(event({ type: 'agent.queued', stepId: 'a', harness: 'claude' }), memory),
    ).toBeNull();
    expect(line(event({ type: 'step.completed', stepId: 'a' }), memory)?.harness).toBe('claude');
    // Forgotten after the terminal event, and never shared with another step or run.
    expect(line(event({ type: 'step.completed', stepId: 'a' }), memory)).not.toHaveProperty(
      'harness',
    );
    memory.observe(event({ type: 'agent.started', stepId: 'b', harness: 'codex' }));
    expect(line(event({ type: 'step.completed', stepId: 'c' }), memory)).not.toHaveProperty(
      'harness',
    );
    expect(
      line(event({ type: 'step.completed', stepId: 'b', runId: 'r2' }), memory),
    ).not.toHaveProperty('harness');
    expect(line(event({ type: 'step.completed', stepId: 'b' }), memory)?.harness).toBe('codex');
  });

  it('derives ms from step.started and run.started, and omits it without a start', () => {
    const memory = new EventLineMemory();
    expect(
      line(event({ type: 'step.completed', stepId: 'a', at: at(9) }), memory),
    ).not.toHaveProperty('ms');
    expect(
      line(event({ type: 'run.started', stepId: null, at: at(0) }), memory),
    ).not.toHaveProperty('ms');
    memory.observe(event({ type: 'step.started', stepId: 'a', at: at(5) }));
    memory.observe(event({ type: 'step.started', stepId: 'b', at: at(6) }));
    expect(line(event({ type: 'step.completed', stepId: 'a', at: at(30) }), memory)?.ms).toBe(25);
    // A retry restarts the clock.
    expect(line(event({ type: 'step.failed', stepId: 'b', at: at(10) }), memory)?.ms).toBe(4);
    memory.observe(event({ type: 'step.started', stepId: 'b', at: at(20) }));
    expect(line(event({ type: 'step.settled', stepId: 'b', at: at(21) }), memory)?.ms).toBe(1);
    expect(
      line(event({ type: 'wait.opened', stepId: 'q', at: at(40) }), memory),
    ).not.toHaveProperty('ms');
    expect(line(event({ type: 'run.completed', stepId: null, at: at(50) }), memory)?.ms).toBe(50);
    expect(memory.size).toEqual({ runs: 0, steps: 0 });
  });

  describe('toolUses and warnings', () => {
    const finished = (
      stepId: string,
      fields: {
        diagnostics?: NonNullable<WorkflowEvent['diagnostics']>;
        warnings?: string[];
        outcome?: 'cancelled';
      } = {},
    ): Parameters<typeof event>[0] => ({
      type: 'agent.finished',
      stepId,
      harness: 'claude',
      ...fields,
    });

    it('writes toolUses after costUsd and the warnings as msg on step.completed', () => {
      const memory = new EventLineMemory();
      memory.observe(event({ type: 'step.started', stepId: 'a', at: at(0) }));
      memory.observe(
        event(
          finished('a', {
            diagnostics: { toolUses: 0 },
            warnings: ['Other note', 'no-tool-use: expected tools, saw none'],
          }),
        ),
      );
      const text = formatEventLine(
        event({
          type: 'step.completed',
          stepId: 'a',
          at: at(5),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
        }),
        memory,
      );
      expect(text).toBe(
        `{"t":"${at(5)}","run":"r1","ev":"step.completed","step":"a","harness":"claude","ms":5,"costUsd":0.5,"toolUses":0,"msg":"no-tool-use: expected tools, saw none; Other note"}`,
      );
    });

    it('keeps no-tool-use in msg when other warnings are long and the line within the cap', () => {
      const memory = new EventLineMemory();
      const long = 'x'.repeat(150);
      memory.observe(
        event(
          finished('a', {
            diagnostics: { toolUses: 0 },
            warnings: [long, long, 'no-tool-use: expected tools'],
          }),
        ),
      );
      const text =
        formatEventLine(
          event({ type: 'step.completed', stepId: 'a', phase: 'p'.repeat(200) }),
          memory,
        ) ?? '';
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
      expect((JSON.parse(text) as EventLine).msg?.startsWith('no-tool-use: expected tools; ')).toBe(
        true,
      );
    });

    it('writes toolUses but never warnings on step.failed and step.settled', () => {
      const memory = new EventLineMemory();
      for (const type of ['step.failed', 'step.settled'] as const) {
        memory.observe(event({ type: 'step.started', stepId: 'a' }));
        memory.observe(
          event(finished('a', { diagnostics: { toolUses: 4 }, warnings: ['no-tool-use: x'] })),
        );
        const parsed = line(event({ type, stepId: 'a', error: 'boom' }), memory);
        expect(parsed).toMatchObject({ ev: type, toolUses: 4, msg: 'boom' });
      }
    });

    it.each([
      ['null', null],
      ['missing', undefined],
      ['a string', '3'],
      ['negative', -1],
      ['fractional', 1.5],
      ['infinite', Infinity],
    ])('omits toolUses when the count is %s', (_name, value) => {
      const memory = new EventLineMemory();
      memory.observe(
        event(
          finished('a', {
            diagnostics: { toolUses: value } as NonNullable<WorkflowEvent['diagnostics']>,
          }),
        ),
      );
      expect(line(event({ type: 'step.completed', stepId: 'a' }), memory)).not.toHaveProperty(
        'toolUses',
      );
    });

    it('gives a step without agent.finished neither field', () => {
      expect(line(event({ type: 'step.completed', stepId: 'a' }))).not.toHaveProperty('toolUses');
      expect(line(event({ type: 'step.completed', stepId: 'a' }))).not.toHaveProperty('msg');
      const memory = new EventLineMemory();
      memory.observe(event(finished('a', { diagnostics: { toolUses: 2 } })));
      expect(line(event({ type: 'wait.opened', stepId: 'a' }), memory)).not.toHaveProperty(
        'toolUses',
      );
    });

    it('ignores a message on step.completed', () => {
      expect(line(event({ type: 'step.completed', message: 'Step done' }))).not.toHaveProperty(
        'msg',
      );
    });

    it('clears values on step.started and forgets them after the terminal event', () => {
      const memory = new EventLineMemory();
      memory.observe(
        event(finished('a', { diagnostics: { toolUses: 5 }, warnings: ['no-tool-use: x'] })),
      );
      memory.observe(event({ type: 'step.started', stepId: 'a' }));
      memory.observe(event({ type: 'agent.started', stepId: 'a', harness: 'claude' }));
      expect(
        line(event({ type: 'step.failed', stepId: 'a', error: 'e' }), memory),
      ).not.toHaveProperty('toolUses');
      memory.observe(event(finished('a', { diagnostics: { toolUses: 1 } })));
      expect(line(event({ type: 'step.completed', stepId: 'a' }), memory)?.toolUses).toBe(1);
      expect(line(event({ type: 'step.completed', stepId: 'a' }), memory)).not.toHaveProperty(
        'toolUses',
      );
      expect(memory.size).toEqual({ runs: 0, steps: 0 });
    });

    it('writes nothing for a cancelled attempt and still releases its memory', () => {
      const memory = new EventLineMemory();
      memory.observe(event({ type: 'step.started', stepId: 'a' }));
      memory.observe(event(finished('a', { diagnostics: { toolUses: 2 }, outcome: 'cancelled' })));
      expect(formatEventLine(event({ type: 'step.cancelled', stepId: 'a' }), memory)).toBeNull();
      expect(memory.size).toEqual({ runs: 0, steps: 0 });
    });
  });

  it('bounds its memory by deleting entries on terminal events', () => {
    const memory = new EventLineMemory();
    memory.observe(event({ type: 'run.started', stepId: null }));
    for (let index = 0; index < 100; index++) {
      const stepId = `s/${String(index)}`;
      memory.observe(event({ type: 'step.started', stepId }));
      memory.observe(event({ type: 'agent.finished', stepId, harness: 'claude' }));
      memory.observe(event({ type: index % 2 ? 'step.completed' : 'step.cancelled', stepId }));
    }
    expect(memory.size).toEqual({ runs: 1, steps: 0 });
    memory.observe(event({ type: 'step.started', stepId: 'left' }));
    memory.observe(event({ type: 'run.failed', stepId: null }));
    expect(memory.size).toEqual({ runs: 0, steps: 0 });
    memory.observe(event({ type: 'step.started', stepId: 'replayed' }));
    memory.observe(event({ type: 'step.replayed', stepId: 'replayed' }));
    expect(memory.size).toEqual({ runs: 0, steps: 0 });
  });

  it('composes log and wait.opened messages', () => {
    expect(
      line(event({ type: 'log', stepId: null, message: 'Scanning', data: { count: 2 } }))?.msg,
    ).toBe('Scanning {"count":2}');
    expect(line(event({ type: 'log', stepId: null, message: 'plain', data: null }))?.msg).toBe(
      'plain',
    );
    expect(
      line(
        event({
          type: 'wait.opened',
          stepId: 'approve',
          data: { question: { prompt: 'Ship?', audience: 'human' } },
        }),
      )?.msg,
    ).toBe('{"prompt":"Ship?","audience":"human"}');
    expect(
      line(event({ type: 'wait.opened', stepId: 'approve', data: { question: null } })),
    ).not.toHaveProperty('msg');
    expect(line(event({ type: 'wait.opened', stepId: 'approve', data: [] }))).not.toHaveProperty(
      'msg',
    );
    expect(line(event({ type: 'phase', stepId: null, message: 'verify' }))?.msg).toBe('verify');
    expect(
      line(event({ type: 'run.failed', stepId: 'a', message: 'Step a failed' })),
    ).toMatchObject({ step: 'a', msg: 'Step a failed' });
  });

  it('writes a tolerated poll error with its wait, count, limit and code, and no attempt', () => {
    const tolerated = (fields: Partial<WorkflowEvent>): WorkflowEvent =>
      event({
        type: 'wait.tolerated',
        stepId: 'ci',
        phase: 'watch',
        attempt: 1,
        message: 'HTTP 502: Bad Gateway',
        data: { consecutive: 2, tolerate: 3 },
        ...fields,
      } as WorkflowEvent);
    const memory = new EventLineMemory();
    expect(formatEventLine(tolerated({}), memory)).toBe(
      `{"t":"${at(0)}","run":"r1","ev":"wait.tolerated","step":"ci","phase":"watch","msg":"tolerated 2/3: HTTP 502: Bad Gateway"}`,
    );
    expect(
      line(tolerated({ data: { consecutive: 1, tolerate: 1, code: 'ENOENT' }, message: 'gone' }))
        ?.msg,
    ).toBe('tolerated 1/1 [ENOENT]: gone');
    // Malformed data (only a hand-edited record could hold it) falls back to the plain message.
    expect(line(tolerated({ data: null }))?.msg).toBe('HTTP 502: Bad Gateway');
    expect(line(tolerated({ data: { consecutive: '2' } }))?.msg).toBe('HTTP 502: Bad Gateway');
    // A started step of the same ID does not give the tolerated line a duration.
    const started = new EventLineMemory();
    formatEventLine(event({ type: 'step.started', stepId: 'ci' }), started);
    expect(line(tolerated({ at: at(50) }), started)).not.toHaveProperty('ms');
    // A long message is truncated within the cap.
    const long = formatEventLine(tolerated({ message: 'x'.repeat(1024) }), memory) ?? '';
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
    const parsed = JSON.parse(long) as EventLine;
    expect(parsed.msg?.startsWith('tolerated 2/3: xxx')).toBe(true);
    expect(parsed.msg?.endsWith('…')).toBe(true);
    expect(line(tolerated({ replayed: true }))).toBeNull();
  });

  it('truncates msg near 200 bytes so a typical line stays near 300', () => {
    const text = formatEventLine(
      event({
        type: 'log',
        stepId: null,
        phase: 'discover',
        message: 'x'.repeat(10_000),
        data: { detail: 'y'.repeat(500) },
      }),
      new EventLineMemory(),
    );
    const bytes = Buffer.byteLength(text ?? '');
    expect(bytes).toBeGreaterThan(250);
    expect(bytes).toBeLessThanOrEqual(320);
    const parsed = JSON.parse(text ?? '') as EventLine;
    expect(parsed.msg?.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(parsed.msg ?? '')).toBeLessThanOrEqual(200);
  });

  it.each([
    ['a long scoped step ID', { stepId: `items/${'deep/'.repeat(60)}leaf` }],
    ['a long multibyte message', { message: '日本語のメッセージ🎉'.repeat(400) }],
    ['escape-heavy data', { message: '"\\\n\u0001'.repeat(500) }],
    ['a lone surrogate', { message: `${'é'.repeat(150)}\ud800${'z'.repeat(400)}` }],
    [
      'everything long at once',
      {
        runId: 'r'.repeat(128),
        stepId: `map/${'語'.repeat(300)}`,
        phase: `phase ${'ü'.repeat(400)}`,
        message: '🎉'.repeat(3_000),
        harness: 'h'.repeat(64),
      },
    ],
  ] as const)('keeps the line within the cap with %s', (_label, fields) => {
    const memory = new EventLineMemory();
    for (const type of [
      'step.failed',
      'log',
      'run.failed',
      'phase',
      'wait.opened',
      'wait.tolerated',
    ] as const) {
      const text =
        formatEventLine(
          event({
            type,
            ...fields,
            data:
              type === 'wait.opened'
                ? { question: { prompt: '問'.repeat(2_000) } }
                : type === 'wait.tolerated'
                  ? { consecutive: 2, tolerate: 3, code: 'E'.repeat(128) }
                  : null,
          }),
          memory,
        ) ?? '';
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
      const parsed = JSON.parse(text) as EventLine;
      expect(parsed.ev).toBe(type);
      expect(parsed.run.length).toBeGreaterThan(0);
    }
  });

  it('middle-truncates a long step ID only when msg cannot absorb the excess', () => {
    const stepId = `${'a'.repeat(300)}/${'b'.repeat(300)}`;
    const parsed = line(event({ type: 'step.completed', stepId }));
    expect(parsed?.step?.startsWith('aaa')).toBe(true);
    expect(parsed?.step?.endsWith('bbb')).toBe(true);
    expect(parsed?.step).toContain('…');
    const short = line(event({ type: 'step.failed', stepId: 'a'.repeat(300), message: 'm' }));
    expect(short?.step).toBe('a'.repeat(300));
  });
});

const noToolUse =
  'no-tool-use: Profile readonly expects tool use, but the claude attempt completed without a tool call.';

describe('shared formatter', () => {
  // The same transitions as the runner emits them live and as a follower reads them back from the
  // record: one formatter produces both lines.
  const run: RunRecord = {
    formatVersion: 7,
    id: 'r1',
    workflow: { name: 'w', version: '1', fingerprint: null },
    cwd: '/',
    input: null,
    output: null,
    status: 'failed',
    error: 'Step a failed',
    rootCause: { stepId: 'a', error: 'boom', errorKind: 'rate-limit', effect: null },
    createdAt: at(0),
    updatedAt: at(90),
    executions: [
      {
        n: 1,
        pid: 1,
        startedAt: at(0),
        endedAt: at(90),
        outcome: 'failed',
        error: 'Step a failed',
        errorStack: null,
      },
    ],
    events: [
      {
        at: at(0),
        execution: 1,
        type: 'run.started',
        phase: null,
        total: null,
        message: null,
        data: null,
        stepId: null,
      },
      {
        at: at(5),
        execution: 1,
        type: 'log',
        phase: 'review',
        total: null,
        message: 'Scanning',
        data: { count: 2 },
        stepId: null,
      },
      {
        at: at(90),
        execution: 1,
        type: 'run.failed',
        phase: 'review',
        total: null,
        message: 'Step a failed',
        data: null,
        stepId: 'a',
      },
    ],
    steps: {
      a: {
        kind: 'codex',
        fingerprint: 'f',
        status: 'failed',
        phase: 'review',
        attempts: 1,
        output: null,
        error: 'boom',
        wakeAt: null,
        attemptHistory: [
          {
            attempt: 1,
            fingerprint: 'f',
            startedAt: at(10),
            finishedAt: at(40),
            durationMs: 30,
            status: 'failed',
            error: 'boom',
            errorKind: 'rate-limit',
            execution: 1,
            request: { harness: 'codex' },
            diagnostics: { toolUses: 3 },
          } as unknown as AttemptRecord,
        ],
      },
      b: {
        kind: 'claude',
        fingerprint: 'f',
        status: 'completed',
        phase: 'review',
        attempts: 1,
        output: null,
        error: null,
        wakeAt: null,
        warnings: [noToolUse],
        attemptHistory: [
          {
            attempt: 1,
            fingerprint: 'f',
            startedAt: at(20),
            finishedAt: at(50),
            durationMs: 30,
            status: 'completed',
            error: null,
            execution: 1,
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
            request: { harness: 'claude' },
            diagnostics: { toolUses: 0 },
          } as unknown as AttemptRecord,
        ],
      },
    },
  };
  const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.5 };
  const live: WorkflowEvent[] = [
    event({ type: 'run.started', stepId: null, at: at(0), message: 'Run started.' }),
    event({
      type: 'log',
      stepId: null,
      at: at(5),
      phase: 'review',
      message: 'Scanning',
      data: { count: 2 },
    }),
    event({ type: 'step.started', stepId: 'a', at: at(10), phase: 'review' }),
    event({ type: 'agent.started', stepId: 'a', at: at(10), harness: 'codex' }),
    event({ type: 'step.started', stepId: 'b', at: at(20), phase: 'review' }),
    event({ type: 'agent.started', stepId: 'b', at: at(20), harness: 'claude' }),
    event({
      type: 'agent.finished',
      stepId: 'a',
      at: at(40),
      diagnostics: { toolUses: 3 },
    }),
    event({
      type: 'step.failed',
      stepId: 'a',
      at: at(40),
      phase: 'review',
      attempt: 1,
      error: 'boom',
      errorKind: 'rate-limit',
    }),
    event({
      type: 'agent.finished',
      stepId: 'b',
      at: at(50),
      diagnostics: { toolUses: 0 },
      warnings: [noToolUse],
    }),
    event({ type: 'step.completed', stepId: 'b', at: at(50), phase: 'review', usage }),
    event({
      type: 'run.failed',
      stepId: 'a',
      at: at(90),
      phase: 'review',
      message: 'Step a failed',
      errorKind: 'rate-limit',
    }),
  ];

  it('gives live events and record entries the same lines, key order and field set', () => {
    const memory = new EventLineMemory();
    const fromLive = live
      .map((input) => formatEventLine(input, memory))
      .filter((text): text is string => text !== null);
    const fromRecord = recordEventLines(run, null, 'all').lines;
    expect(fromLive.map((text) => (JSON.parse(text) as EventLine).ev)).toEqual([
      'run.started',
      'log',
      'step.failed',
      'step.completed',
      'run.failed',
    ]);
    // The durations line up here by construction; in general `ms` is process-observed live and
    // the recorded attempt or execution duration in the record (documented under the field).
    expect(fromRecord).toEqual(fromLive);
    expect(JSON.parse(fromLive[2] ?? '')).toMatchObject({
      ev: 'step.failed',
      msg: 'boom',
      errorKind: 'rate-limit',
      retryable: true,
      toolUses: 3,
    });
    expect(JSON.parse(fromLive[3] ?? '')).toMatchObject({
      ev: 'step.completed',
      toolUses: 0,
      msg: noToolUse,
    });
    expect(JSON.parse(fromLive[4] ?? '')).toMatchObject({
      ev: 'run.failed',
      step: 'a',
      errorKind: 'rate-limit',
      retryable: true,
    });
    for (const text of [...fromLive, ...fromRecord]) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const order = [
        't',
        'run',
        'ev',
        'step',
        'attempt',
        'errorKind',
        'retryable',
        'harness',
        'ms',
        'costUsd',
        'toolUses',
        'phase',
        'msg',
      ];
      const keys = Object.keys(parsed);
      expect(keys).toEqual(order.filter((key) => keys.includes(key)));
    }
  });

  it('gives a tolerated poll error the same line live and from the record', () => {
    const entry = {
      at: at(30),
      execution: 1,
      type: 'wait.tolerated' as const,
      phase: 'review',
      total: null,
      message: 'HTTP 502',
      data: { consecutive: 1, tolerate: 3, code: 'ECONNRESET' },
      stepId: 'ci',
    };
    const fromRecord = recordEventLines(
      { ...run, events: [entry], steps: {}, executions: [] },
      null,
      'all',
    ).lines;
    const fromLive = formatEventLine(
      event({ ...entry, runId: 'r1', attempt: 1, message: entry.message }),
      new EventLineMemory(),
    );
    expect(fromRecord).toEqual([fromLive]);
    expect(JSON.parse(fromLive ?? '')).toEqual({
      t: at(30),
      run: 'r1',
      ev: 'wait.tolerated',
      step: 'ci',
      phase: 'review',
      msg: 'tolerated 1/3 [ECONNRESET]: HTTP 502',
    });
  });

  it('formats raw fields with omission and the attempt rule in one place', () => {
    expect(
      formatEventFields({
        t: at(0),
        run: 'r1',
        ev: 'step.completed',
        step: '',
        attempt: 2,
        costUsd: null,
        phase: '',
        msg: '',
      }),
    ).toBe(`{"t":"${at(0)}","run":"r1","ev":"step.completed"}`);
    expect(
      JSON.parse(formatEventFields({ t: at(0), run: 'r1', ev: 'step.settled', attempt: 2 })),
    ).toMatchObject({ attempt: 2 });
  });

  it('formats the failure pair from a recorded kind in one place', () => {
    const base = { t: at(0), run: 'r1', step: 'a', attempt: 1 } as const;
    expect(
      formatEventFields({ ...base, ev: 'step.failed', errorKind: 'rate-limit', msg: 'x' }),
    ).toBe(
      `{"t":"${at(0)}","run":"r1","ev":"step.failed","step":"a","attempt":1,"errorKind":"rate-limit","retryable":true,"msg":"x"}`,
    );
    expect(
      JSON.parse(formatEventFields({ ...base, ev: 'step.failed', errorKind: 'schema' })),
    ).toMatchObject({
      errorKind: 'schema',
      retryable: false,
    });
    expect(formatEventFields({ ...base, ev: 'step.failed' })).toContain(
      '"errorKind":null,"retryable":false',
    );
    expect(
      JSON.parse(formatEventFields({ ...base, ev: 'run.failed', errorKind: 'timeout' })),
    ).toMatchObject({
      errorKind: 'timeout',
      retryable: true,
    });
    for (const fields of [
      { ...base, ev: 'run.failed' as const },
      { ...base, ev: 'run.failed' as const, step: null, errorKind: 'timeout' as const },
      { ...base, ev: 'step.settled' as const, errorKind: 'timeout' as const },
      { ...base, ev: 'step.completed' as const, errorKind: 'timeout' as const },
      { ...base, ev: 'log' as const, errorKind: 'timeout' as const },
    ])
      expect(JSON.parse(formatEventFields(fields))).not.toHaveProperty('errorKind');
  });
});

describe('WorkflowEventLog', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function directory(): string {
    const root = mkdtempSync(join(tmpdir(), 'qc-events-'));
    roots.push(root);
    return root;
  }
  function logger(): ExecutionLogger & { readonly warnings: string[] } {
    const warnings: string[] = [];
    return {
      warnings,
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
    };
  }
  const completed = event({ type: 'step.completed', stepId: 'a' });

  it('creates the file owner-only and writes one line per event', () => {
    const path = join(directory(), 'events.jsonl');
    const log = new WorkflowEventLog({ target: { path }, logger: logger() });
    log.open();
    log.observe(event({ type: 'run.started', stepId: null }));
    log.observe(event({ type: 'agent.started', stepId: 'a', harness: 'claude' }));
    log.observe(completed);
    // Flushed per line: readable before close.
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    log.close();
    log.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('appends to an existing file', () => {
    const path = join(directory(), 'events.jsonl');
    writeFileSync(path, '{"earlier":true}\n', { mode: 0o600 });
    const log = new WorkflowEventLog({ target: { path }, logger: logger() });
    log.open();
    log.observe(completed);
    log.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('{"earlier":true}');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ ev: 'step.completed', step: 'a' });
  });

  it('warns once and never throws when the path cannot be opened', () => {
    const sink = logger();
    const log = new WorkflowEventLog({
      target: { path: join(directory(), 'missing', 'events.jsonl') },
      logger: sink,
    });
    expect(() => {
      log.open();
      log.observe(completed);
      log.observe(completed);
      log.close();
    }).not.toThrow();
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toMatch(/^Events: .*ENOENT.*; further events are not written\.$/u);
  });

  it('warns once and then stays silent when a file write fails', () => {
    const path = join(directory(), 'events.jsonl');
    const sink = logger();
    const log = new WorkflowEventLog({ target: { path }, logger: sink });
    log.open();
    log.observe(completed);
    fsControl.failWrites = true;
    try {
      expect(() => {
        log.observe(completed);
        log.observe(completed);
      }).not.toThrow();
    } finally {
      fsControl.failWrites = false;
    }
    log.observe(completed);
    log.close();
    expect(sink.warnings).toEqual([
      'Events: ENOSPC: no space left on device, write; further events are not written.',
    ]);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('warns once when an injected writer throws or reports an error', () => {
    const sink = logger();
    const write = vi.fn(() => {
      throw new Error('EPIPE: broken pipe');
    });
    const log = new WorkflowEventLog({ target: { write }, logger: sink });
    log.open();
    log.observe(completed);
    log.observe(completed);
    expect(write).toHaveBeenCalledTimes(1);
    expect(sink.warnings).toEqual(['Events: EPIPE: broken pipe; further events are not written.']);

    const late = logger();
    const lines: string[] = [];
    const asyncLog = new WorkflowEventLog({
      target: {
        write: (text, onError) => {
          lines.push(text);
          onError(new Error('write after end'));
        },
      },
      logger: late,
    });
    asyncLog.observe(completed);
    asyncLog.observe(completed);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(late.warnings).toHaveLength(1);
  });

  it('does not let a throwing logger escape', () => {
    const log = new WorkflowEventLog({
      target: { path: join(directory(), 'missing', 'events.jsonl') },
      logger: {
        log: () => {
          throw new Error('logger closed');
        },
      },
    });
    expect(() => {
      log.open();
    }).not.toThrow();
  });
});

describe('eventLogEntry', () => {
  it('logs a tolerated poll error at info with its wait and count, like phases and logs', () => {
    const tolerated = event({
      type: 'wait.tolerated',
      stepId: 'ci',
      message: 'HTTP 502',
      data: { consecutive: 1, tolerate: 3 },
    });
    expect(eventLogEntry(tolerated, false)).toEqual({
      level: 'info',
      message: `${at(0)} r1 wait.tolerated ci tolerated 1/3: HTTP 502`,
    });
    expect(eventLogEntry(event({ type: 'log', stepId: null, message: 'm' }), false).level).toBe(
      'info',
    );
    expect(eventLogEntry(event({ type: 'step.failed' }), false).level).toBe('debug');
    // The step error rides its own field, so the debug line still names the step and attempt.
    const failed = eventLogEntry(event({ type: 'step.failed', stepId: 'a', error: 'boom' }), false);
    expect(failed).toEqual(eventLogEntry(event({ type: 'step.failed', stepId: 'a' }), false));
    expect(failed.message).not.toContain('boom');
    expect(eventLogEntry(event({ type: 'agent.progress' }), true).level).toBe('info');
    expect(eventLogEntry(event({ type: 'replay.divergence' }), false).level).toBe('warn');
  });
});

describe('requestedEventsStdout', () => {
  it.each<[string[], boolean]>([
    [['execute', 'wf.ts', '--events', '-'], true],
    [['execute', 'wf.ts', '--events=-'], true],
    [['execute', 'wf.ts', '--events', 'events.jsonl'], false],
    [['execute', 'wf.ts', '--events', './-file'], false],
    [['execute', 'wf.ts', '--events=-file'], false],
    [['execute', 'wf.ts', '--', '--events', '-'], false],
    [['execute', 'wf.ts', '--events', '--', '-'], false],
    [['execute', 'wf.ts', '--input', '-'], false],
    [['execute', 'wf.ts'], false],
  ])('%j -> %s', (argv, expected) => {
    expect(requestedEventsStdout(argv)).toBe(expected);
  });

  it('counts the answer --json VALUE alias as JSON output', () => {
    const argv = ['run', 'step', '--json', '{"ok":true}', '--resume', '--events', '-'];
    expect(requestedEventsStdout(argv) && requestedJson(argv)).toBe(true);
  });
});

describe('WorkflowExecutor with plan.events', () => {
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  function workflow() {
    root = mkdtempSync(join(tmpdir(), 'qc-events-executor-'));
    symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'workflow.ts');
    writeFileSync(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'events', version: '1', input: z.null(), output: z.number(),
  run: async (ctx) => {
    ctx.log('start', { n: 1 });
    return ctx.step('one', { input: null, schema: z.number(), run: () => 1 });
  } });
`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, root);
    if (!analysis.ok) throw new Error(analysis.error.message);
    return {
      kind: 'workflow.execute' as const,
      typecheck: analysis.plan,
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: null,
    };
  }

  // measured: 1.7 s alone, 26.2 s in a full coverage run on a loaded machine (twice 20 s+; two
  // executions dominated by full TypeScript type checks and tsImport compiles)
  it(
    'writes to the injected stdout writer and to an appended file',
    { timeout: 80_000 },
    async () => {
      const plan = workflow();
      const lines: string[] = [];
      const executor = new WorkflowExecutor({
        logger: { log: () => undefined },
        eventsStdout: (line) => lines.push(line),
      });
      expect(await executor.execute({ ...plan, runId: 'stdout', events: '-' })).toMatchObject({
        ok: true,
      });
      expect(lines.map((line) => (JSON.parse(line) as EventLine).ev)).toEqual([
        'run.started',
        'log',
        'step.completed',
        'run.completed',
      ]);
      const file = join(root ?? '', 'events.jsonl');
      expect(await executor.execute({ ...plan, runId: 'file', events: file })).toMatchObject({
        ok: true,
      });
      expect(
        readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as EventLine).run),
      ).toEqual(['file', 'file', 'file', 'file']);
      // Without a stdout writer, '-' is a usage error, not a write to process.stdout.
      const refused = await new WorkflowExecutor({ logger: { log: () => undefined } }).execute({
        ...plan,
        runId: 'no-writer',
        events: '-',
      });
      expect(refused).toMatchObject({ ok: false, code: 'usage.flag' });
    },
  );
});
