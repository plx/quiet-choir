import type { AgentUsage, HarnessResponse } from '../workflow/runtime/model.js';

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

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usage(value: unknown, cost?: unknown): AgentUsage {
  const data = record(value);
  return {
    inputTokens: number(data?.['input_tokens']),
    outputTokens: number(data?.['output_tokens']),
    costUsd: number(cost),
  };
}

function message(value: unknown): string {
  const data = record(value);
  return typeof data?.['message'] === 'string'
    ? data['message']
    : JSON.stringify(value).slice(0, 2048);
}

/** Normalize Claude's single JSON result, rejecting reported agent errors even on exit zero. */
export function parseClaude(stdout: string, structured: boolean): HarnessResponse {
  const data = parse(stdout, 'Claude');
  if (data['type'] !== 'result') throw new Error('Claude did not return a terminal result.');
  if (data['is_error'] === true || data['subtype'] !== 'success') {
    throw new Error(
      `Claude reported ${String(data['subtype'])}: ${message(data['errors'] ?? data['result'] ?? 'agent failure')}`,
    );
  }
  let text: string;
  if (structured) {
    if (!Object.hasOwn(data, 'structured_output'))
      throw new Error('Claude did not return structured_output for the requested schema.');
    text = JSON.stringify(data['structured_output']);
  } else {
    if (typeof data['result'] !== 'string') throw new Error('Claude result is missing final text.');
    text = data['result'];
  }
  return {
    text,
    sessionId: typeof data['session_id'] === 'string' ? data['session_id'] : null,
    usage: usage(data['usage'], data['total_cost_usd']),
  };
}

/** Normalize Codex JSONL, requiring a successful terminal turn and a final agent message. */
export function parseCodex(stdout: string): HarnessResponse {
  let text: string | undefined;
  let sessionId: string | null = null;
  let completed = false;
  let tokens = usage(undefined);
  for (const line of stdout.split(/\r?\n/u).filter((line) => line.trim())) {
    const data = parse(line, 'Codex');
    if (typeof data['type'] !== 'string') throw new Error('Codex event is missing its type.');
    switch (data['type']) {
      case 'thread.started':
        if (typeof data['thread_id'] === 'string') sessionId = data['thread_id'];
        break;
      case 'item.completed': {
        const item = record(data['item']);
        if (item?.['type'] === 'agent_message') {
          if (typeof item['text'] !== 'string')
            throw new Error('Codex agent_message is missing final text.');
          text = item['text'];
        }
        break;
      }
      case 'turn.completed':
        completed = true;
        tokens = usage(data['usage']);
        break;
      case 'turn.failed':
      case 'error':
        throw new Error(
          `Codex reported ${data['type']}: ${message(data['error'] ?? data['message'] ?? 'agent failure')}`,
        );
    }
  }
  if (!completed)
    throw new Error(
      'Codex output ended without turn.completed; the call may have been interrupted.',
    );
  if (text === undefined) throw new Error('Codex completed without a final agent_message.');
  return { text, sessionId, usage: tokens };
}
