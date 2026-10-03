import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  childEnvironment,
  createInvocationStream,
  JsonLines,
  outputLimitCode,
  outputLimitError,
  promptedStructuredOutput,
  standaloneInvocation,
  type AgentProgress,
  type HarnessInvocation,
} from '../src/harness-kit.js';
// The runtime's own classifier: what an adapter's error becomes in a step record.
import { errorKind } from '../src/workflow/runtime/step-error.js';

describe('childEnvironment', () => {
  it('scrubs host agent-session variables by pattern and keeps authentication and behavior names', () => {
    const removed = {
      CLAUDECODE: '1',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge',
      CLAUDE_PLUGIN_DATA: '/plugin',
      CODEX_COMPANION_SESSION_ID: 'companion',
      CODEX_COMPANION_TRANSCRIPT_PATH: '/transcript',
    };
    const kept = {
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
      CODEX_HOME: '/codex-home',
      CODEX_API_KEY: 'codex-key',
      PATH: '/bin',
    };
    const parent = { ...removed, ...kept };
    const before = { ...parent };
    const result = childEnvironment(undefined, undefined, parent);
    expect(result.env).toEqual(kept);
    expect(result.summary.scrubbed).toEqual(Object.keys(removed).sort());
    expect(result.summary.variables).toEqual(
      Object.keys(kept)
        .filter((name) => name !== 'PATH')
        .sort(),
    );
    expect(parent).toEqual(before);
  });

  it.each([
    ['CLAUDE_CODE_SESSION_ID', true],
    ['CLAUDE_CODE_ENTRYPOINT', true],
    ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', true],
    ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', true],
    ['CLAUDE_PLUGIN_ROOT', true],
    ['CLAUDE_PID', true],
    ['CLAUDE_EFFORT', true],
    ['CODEX_THREAD_ID', true],
    ['CODEX_SESSION_ID', true],
    ['CODEX_TURN_ID', true],
    ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE', true],
    ['AI_AGENT', true],
    ['TRACEPARENT', true],
    ['CLAUDE_CODE_USE_VERTEX', false],
    ['CLAUDE_CONFIG_DIR', false],
    ['CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR', false],
    ['OPENAI_API_KEY', false],
    ['CODEX_HOME', false],
    ['MAX_THINKING_TOKENS', false],
  ])('scrubs %s: %s', (name, scrubbed) => {
    const result = childEnvironment(undefined, undefined, { [name]: 'value' });
    expect(Object.hasOwn(result.env, name)).toBe(!scrubbed);
    expect(result.summary.scrubbed).toEqual(scrubbed ? [name] : []);
  });

  it('adds exact names, honors the false opt-out and applies explicit edits after scrubbing', () => {
    const parent = { CLAUDECODE: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1', EXTRA: 'x', KEEP: 'k' };
    const extended = childEnvironment(
      { set: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' }, unset: ['KEEP'] },
      ['EXTRA'],
      parent,
    );
    expect(extended.env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' });
    expect(extended.summary.scrubbed).toEqual([
      'CLAUDECODE',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'EXTRA',
    ]);
    const retained = childEnvironment(undefined, false, parent);
    expect(retained.env).toEqual(parent);
    expect(retained.summary.scrubbed).toEqual([]);
    expect(() => childEnvironment(undefined, ['not a name'], parent)).toThrow('scrubEnv');
  });
});

describe('JsonLines', () => {
  it('frames lines across chunk boundaries, skips blank lines and flushes a final partial line', async () => {
    const lines: string[] = [];
    const reader = new JsonLines(1024, async (line) => {
      await delay(1);
      lines.push(line);
    });
    for (const chunk of ['{"a":', '1}\n\n  \n{"b"', ':2}\n{"c":3}'])
      await reader.feed(Buffer.from(chunk));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    await reader.finish();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('skips an oversized line only when its prefix is accepted, and otherwise fails as output-limit', async () => {
    const lines: string[] = [];
    const prefixes: string[] = [];
    const skipping = new JsonLines(
      16,
      (line) => {
        lines.push(line);
      },
      (prefix) => {
        prefixes.push(prefix);
        return prefix.startsWith('{"noise"');
      },
    );
    await skipping.feed(Buffer.from(`{"noise":"${'x'.repeat(64)}"}\n{"ok":1}\n`));
    expect(lines).toEqual(['{"ok":1}']);
    expect(prefixes).toHaveLength(1);
    await expect(skipping.feed(Buffer.from(`{"answer":"${'x'.repeat(64)}"}\n`))).rejects.toThrow(
      'maxRetainedBytes (16 bytes)',
    );

    const strict = new JsonLines(16, () => undefined);
    const failure: unknown = await strict
      .feed(Buffer.from(`{"noise":"${'x'.repeat(64)}"}\n`))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: outputLimitCode });
    expect(errorKind(failure)).toBe('output-limit');
    expect(() => new JsonLines(0, () => undefined)).toThrow('positive integer');
  });
});

describe('outputLimitError', () => {
  it('carries the documented code that the runtime classifies as output-limit', () => {
    const error = outputLimitError('fake-cli exceeded 10 bytes.');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('fake-cli exceeded 10 bytes.');
    expect(error.code).toBe('QUIET_CHOIR_OUTPUT_LIMIT');
    expect(outputLimitCode).toBe('QUIET_CHOIR_OUTPUT_LIMIT');
    expect(errorKind(error)).toBe('output-limit');
  });
});

function invocation(overrides: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return {
    ...standaloneInvocation({ runId: 'r', stepId: 's', attempt: 1 }, new AbortController().signal),
    ...overrides,
  };
}

describe('createInvocationStream', () => {
  it('awaits the onOutput tee before the downstream consumer sees a chunk', async () => {
    const order: string[] = [];
    const stream = createInvocationStream({
      invocation: invocation({
        onOutput: async (name, chunk) => {
          await delay(5);
          order.push(`tee:${name}:${Buffer.from(chunk).toString()}`);
        },
      }),
      stdout: (chunk) => {
        order.push(`parse:${Buffer.from(chunk).toString()}`);
      },
    });
    await stream.stdout(Buffer.from('a'));
    await stream.stderr(Buffer.from('b'));
    await stream.stdout(Buffer.from('c'));
    expect(order).toEqual(['tee:stdout:a', 'parse:a', 'tee:stderr:b', 'tee:stdout:c', 'parse:c']);
  });

  it('reports the first session once, only after onSession resolves, and retries after a rejection', async () => {
    const sessions: string[] = [];
    let fail = true;
    const stream = createInvocationStream({
      invocation: invocation({
        onSession: async (id) => {
          await delay(1);
          sessions.push(id);
          if (fail) {
            fail = false;
            throw new Error('session write failed');
          }
        },
      }),
    });
    await expect(stream.session('first')).rejects.toThrow('session write failed');
    await stream.session('');
    await Promise.all([stream.session('first'), stream.session('first')]);
    await stream.session('second');
    expect(sessions).toEqual(['first', 'first']);
  });

  it('delivers the first init at once, throttles other progress and swallows observer errors', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const seen: string[] = [];
    const stream = createInvocationStream({
      invocation: invocation({
        onProgress: (event) => {
          seen.push(event.summary);
          if (event.kind === 'tool') throw new Error('observer failed');
        },
      }),
    });
    const event = (kind: AgentProgress['kind'], summary: string, at: number): void => {
      now = at;
      stream.progress({ kind, summary });
    };
    event('tool', 'tool 1', 1000);
    event('status', 'status dropped', 1050);
    event('init', 'init', 1060);
    event('init', 'init again dropped', 1070);
    event('message', 'message dropped', 1159);
    event('message', 'message', 1160);
    expect(seen).toEqual(['tool 1', 'init', 'message']);
  });

  it('forwards stdout and does nothing else without an invocation', async () => {
    const parsed: string[] = [];
    const stream = createInvocationStream({
      stdout: (chunk) => {
        parsed.push(Buffer.from(chunk).toString());
      },
    });
    await stream.stdout(Buffer.from('x'));
    await stream.stderr(Buffer.from('y'));
    await stream.session('id');
    stream.progress({ kind: 'init', summary: 'init' });
    expect(parsed).toEqual(['x']);
    await expect(createInvocationStream().stdout(Buffer.from('z'))).resolves.toBeUndefined();
  });
});

describe('standaloneInvocation', () => {
  it('carries the request identity and signal with a no-op process registration', async () => {
    const controller = new AbortController();
    const standalone = standaloneInvocation(
      { runId: 'run', stepId: 'scope/step', attempt: 3 },
      controller.signal,
    );
    expect(standalone).toMatchObject({ runId: 'run', stepId: 'scope/step', attempt: 3 });
    expect(standalone.signal).toBe(controller.signal);
    expect(standalone.onSession).toBeUndefined();
    expect(standalone.onOutput).toBeUndefined();
    const registration = await standalone.trackProcess({
      pid: 1,
      pgid: 1,
      binary: 'fake',
      cwd: '/',
      startedAt: new Date(0).toISOString(),
      identity: null,
    } as unknown as Parameters<HarnessInvocation['trackProcess']>[0]);
    await expect(registration.release()).resolves.toBeUndefined();
  });
});

describe('promptedStructuredOutput', () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  };
  const prompted = promptedStructuredOutput(schema);

  it('asks for one JSON value conforming to the embedded schema', () => {
    expect(prompted.instructions).toContain(JSON.stringify(schema));
    expect(prompted.instructions).toMatch(/^\n\n/u);
    expect(prompted.instructions).toContain('exactly one JSON value');
  });

  it.each([
    ['bare JSON', ' {"ok": true}\n', '{"ok":true}'],
    ['a bare array', '[1, 2]', '[1,2]'],
    ['a json fence inside prose', 'Here it is:\n```json\n{"ok": true}\n```\nDone.', '{"ok":true}'],
    [
      'the last parseable fence',
      '```json\n{"ok": false}\n```\nCorrected:\n```\n{"ok": true}\n```\n```ts\nconst x = {}\n```',
      '{"ok":true}',
    ],
    ['an object in prose', 'The result is {"ok": false} as requested.', '{"ok":false}'],
    ['an object after a citation', 'According to [1], the result is {"ok": true}', '{"ok":true}'],
  ])('extracts %s', (_name, text, expected) => {
    expect(prompted.extract(text)).toBe(expected);
  });

  it('prefers the span matching an array schema over an earlier object-like span', () => {
    const array = promptedStructuredOutput({ type: 'array' });
    expect(array.extract('See {note} then [1,2]')).toBe('[1,2]');
  });

  it('keeps the earliest span when the schema has no single top-level type', () => {
    const untyped = promptedStructuredOutput({ anyOf: [{ type: 'object' }, { type: 'array' }] });
    expect(untyped.extract('According to [1], the result is {"ok": true}')).toBe('[1]');
  });

  it('throws a SyntaxError, classified as schema, when the answer holds no JSON', () => {
    let failure: unknown;
    try {
      prompted.extract('I could not determine the answer {not json}.');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(errorKind(failure)).toBe('schema');
  });
});
