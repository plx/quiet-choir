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
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
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
    'child.completed',
    'child.failed',
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
          message: 'boom',
          usage: { inputTokens: null, outputTokens: null, costUsd: 0.5 },
        }),
        memory,
      ),
    ).toBe(
      `{"t":"${at(40)}","run":"r1","ev":"step.failed","step":"a","attempt":2,"harness":"codex","ms":40,"costUsd":0.5,"phase":"review","msg":"boom"}`,
    );
  });

  it('puts attempt only on step.failed and step.settled', () => {
    expect(line(event({ type: 'step.settled', attempt: 3 }))?.attempt).toBe(3);
    expect(line(event({ type: 'step.completed', attempt: 3 }))).not.toHaveProperty('attempt');
    expect(line(event({ type: 'wait.opened', attempt: 3 }))).not.toHaveProperty('attempt');
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
    for (const type of ['step.failed', 'log', 'run.failed', 'phase', 'wait.opened'] as const) {
      const text =
        formatEventLine(
          event({
            type,
            ...fields,
            data: type === 'wait.opened' ? { question: { prompt: '問'.repeat(2_000) } } : null,
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

  // measured: 1.7 s alone, three executions dominated by type checks and tsImport compiles
  it(
    'writes to the injected stdout writer and to an appended file',
    { timeout: 20_000 },
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
