import type { ProtocolFailure } from '../workflow/runtime/harness-error.js';
import type { AgentUsage, HarnessResponse } from '../workflow/runtime/model.js';
import { claudeUsage, codexUsage } from './usage.js';

/** Protocol classification, evaluated independently of the process exit code. */
export type ProtocolOutcome =
  | {
      readonly kind: 'success';
      readonly response: HarnessResponse & { readonly usage: AgentUsage };
    }
  | { readonly kind: 'failure'; readonly failure: ProtocolFailure }
  | { readonly kind: 'unparseable'; readonly reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parse(value: string, provider: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`${provider} returned malformed JSON. Check the installed CLI version.`, {
      cause,
    });
  }
  const object = record(parsed);
  if (object === undefined) throw new Error(`${provider} returned a non-object protocol message.`);
  return object;
}

function classify(read: () => ProtocolOutcome): ProtocolOutcome {
  try {
    return read();
  } catch (error) {
    return { kind: 'unparseable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function message(value: unknown): string {
  const data = record(value);
  const text =
    typeof value === 'string'
      ? value
      : typeof data?.['message'] === 'string'
        ? data['message']
        : Array.isArray(value)
          ? value.map(message).join('; ')
          : JSON.stringify(value);
  return text.slice(0, 2048);
}

// Codex embeds API error JSON inside error.message. Unwrap only bounded nesting.
function apiError(value: unknown, depth = 0): { reason: string; status: number | null } {
  if (depth >= 4) return { reason: message(value), status: null };
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (record(parsed)) return apiError(parsed, depth + 1);
    } catch {
      /* Plain text is the usual message format. */
    }
  }
  const data = record(value);
  if (data && (data['error'] !== undefined || data['message'] !== undefined)) {
    const nested = apiError(data['error'] ?? data['message'], depth + 1);
    return { reason: nested.reason, status: number(data['status']) ?? nested.status };
  }
  return { reason: message(value), status: null };
}

/** Classify Claude's terminal envelope. Real agent failures normally accompany exit 1. */
export function parseClaude(
  stdout: string,
  structured: boolean,
  requested: string | null = null,
): ProtocolOutcome {
  return classify(() => {
    let data: Record<string, unknown>;
    try {
      data = parse(stdout, 'Claude');
    } catch {
      const state = new ClaudeProtocol(structured, requested);
      for (const line of stdout.split(/\r?\n/u).filter((line) => line.trim()))
        state.feed(parse(line, 'Claude'));
      return state.finish();
    }
    if (data['type'] !== 'result') throw new Error('Claude did not return a terminal result.');
    const turns = number(data['num_turns']);
    const metadata = {
      ...(turns === null ? {} : { turns }),
      ...(Array.isArray(data['permission_denials'])
        ? { permissionDenials: data['permission_denials'].length }
        : {}),
      sessionId: string(data['session_id']),
      usage: claudeUsage(data, requested),
    };
    if (data['is_error'] === true || data['subtype'] !== 'success') {
      return {
        kind: 'failure',
        failure: {
          ...metadata,
          reason: message(data['errors'] ?? data['result'] ?? 'agent failure'),
          subtype: string(data['subtype']),
          terminalReason: string(data['terminal_reason']),
          apiStatus: number(data['api_error_status']),
        },
      };
    }
    let text: string;
    if (structured) {
      if (!Object.hasOwn(data, 'structured_output'))
        throw new Error('Claude did not return structured_output for the requested schema.');
      text = JSON.stringify(data['structured_output']);
    } else {
      if (typeof data['result'] !== 'string')
        throw new Error('Claude result is missing final text.');
      text = data['result'];
    }
    return { kind: 'success', response: { text, ...metadata } };
  });
}

/** Incremental Claude terminal state; startup and post-result events are accepted. @internal */
export class ClaudeProtocol {
  readonly #structured: boolean;
  readonly #requested: string | null;
  #outcome: ProtocolOutcome | undefined;
  #sessionId: string | null = null;
  #usage: AgentUsage | null = null;
  #text: string | null = null;

  public constructor(structured: boolean, requested: string | null = null) {
    this.#structured = structured;
    this.#requested = requested;
  }
  public get sessionId(): string | null {
    return this.#sessionId;
  }
  public get usage(): AgentUsage | null {
    return this.#usage;
  }
  public get text(): string | null {
    return this.#outcome?.kind === 'success' ? this.#outcome.response.text : this.#text;
  }
  public get retainedBytes(): number {
    return Buffer.byteLength(
      JSON.stringify({
        outcome: this.#outcome,
        sessionId: this.#sessionId,
        usage: this.#usage,
        text: this.#text,
      }),
    );
  }
  public feed(data: Record<string, unknown>): void {
    if (typeof data['type'] !== 'string') throw new Error('Claude event is missing its type.');
    this.#sessionId ??= string(data['session_id']);
    if (data['type'] !== 'result') return;
    this.#usage = claudeUsage(data, this.#requested);
    this.#outcome = parseClaude(JSON.stringify(data), this.#structured, this.#requested);
    this.#text = this.#outcome.kind === 'success' ? null : string(data['result']);
  }
  public finish(): ProtocolOutcome {
    return (
      this.#outcome ?? { kind: 'unparseable', reason: 'Claude did not return a terminal result.' }
    );
  }
}

/** Incremental Codex protocol state; command output and unknown events are never retained. @internal */
export class CodexProtocol {
  readonly #requested: string | null;
  public constructor(requested: string | null = null) {
    this.#requested = requested;
  }
  #text: string | undefined;
  #sessionId: string | null = null;
  #completed = false;
  #tokens: AgentUsage | null = null;
  #failed: ReturnType<typeof apiError> | undefined;
  #lastError: ReturnType<typeof apiError> | undefined;
  readonly #notices: string[] = [];

  public get sessionId(): string | null {
    return this.#sessionId;
  }
  public get usage(): AgentUsage | null {
    return this.#tokens;
  }
  public get text(): string | null {
    return this.#text ?? null;
  }
  public get retainedBytes(): number {
    return Buffer.byteLength(
      JSON.stringify({
        text: this.#text,
        sessionId: this.#sessionId,
        tokens: this.#tokens,
        failed: this.#failed,
        lastError: this.#lastError,
        notices: this.#notices,
      }),
    );
  }

  public feed(data: Record<string, unknown>): void {
    if (typeof data['type'] !== 'string') throw new Error('Codex event is missing its type.');
    switch (data['type']) {
      case 'thread.started':
        if (typeof data['thread_id'] === 'string') this.#sessionId ??= data['thread_id'];
        break;
      case 'item.completed': {
        const item = record(data['item']);
        if (item?.['type'] === 'agent_message') {
          if (typeof item['text'] !== 'string')
            throw new Error('Codex agent_message is missing final text.');
          this.#text = item['text'];
        }
        break;
      }
      case 'turn.completed':
        this.#completed = true;
        this.#tokens = codexUsage(data['usage'], this.#requested);
        break;
      case 'turn.failed':
        this.#failed = apiError(data['error'] ?? 'agent failure');
        if (data['usage'] !== undefined) this.#tokens = codexUsage(data['usage'], this.#requested);
        break;
      case 'error': {
        const error = apiError(data['message'] ?? data['error'] ?? 'agent failure');
        this.#notices.push(error.reason);
        if (this.#notices.length > 32) this.#notices.shift();
        if (!error.reason.startsWith('Reconnecting...')) this.#lastError = error;
        break;
      }
    }
  }

  public finish(): ProtocolOutcome {
    return classify(() => {
      if (this.#failed !== undefined || (!this.#completed && this.#notices.length > 0)) {
        const error = this.#failed ?? this.#lastError;
        const history = this.#notices
          .filter((notice) => notice !== error?.reason)
          .join('; ')
          .slice(-4096);
        return {
          kind: 'failure',
          failure: {
            reason: `${error?.reason ?? 'Codex output ended without turn.completed; the call may have been interrupted.'}${history ? `; notices: ${history}` : ''}`,
            subtype: this.#failed === undefined ? 'error' : 'turn.failed',
            terminalReason: null,
            apiStatus: error?.status ?? null,
            sessionId: this.#sessionId,
            usage: this.#tokens,
          },
        };
      }
      if (!this.#completed)
        throw new Error(
          'Codex output ended without turn.completed; the call may have been interrupted.',
        );
      if (this.#text === undefined)
        throw new Error('Codex completed without a final agent_message.');
      return {
        kind: 'success',
        response: {
          text: this.#text,
          sessionId: this.#sessionId,
          usage: this.#tokens ?? codexUsage(undefined, this.#requested),
          ...(this.#notices.length ? { warnings: [...this.#notices] } : {}),
        },
      };
    });
  }
}

/** Classify buffered Codex JSONL through the same incremental protocol state. */
export function parseCodex(stdout: string, requested: string | null = null): ProtocolOutcome {
  return classify(() => {
    const state = new CodexProtocol(requested);
    for (const line of stdout.split(/\r?\n/u).filter((line) => line.trim()))
      state.feed(parse(line, 'Codex'));
    return state.finish();
  });
}
