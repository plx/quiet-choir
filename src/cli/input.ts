import { jsonErrorPosition } from './json-position.js';
import { addAbortListener } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { JsonValue } from '../workflow/runtime/model.js';
import { workflowFailure } from '../workflow/loader/failure.js';
import { WorkflowCommandError } from './workflow-errors.js';

/** Resolve inline JSON, @file, or stdin before importing workflow code. @internal */
export async function readWorkflowInput(value: string, signal: AbortSignal): Promise<JsonValue> {
  const source =
    value === '-' ? 'stdin' : value.startsWith('@') ? resolve(value.slice(1)) : '--input';
  let text = value;
  try {
    if (value === '-') {
      signal.throwIfAborted();
      const listener = addAbortListener(signal, () => {
        process.stdin.destroy(new Error('Input interrupted.'));
      });
      try {
        process.stdin.setEncoding('utf8');
        text = '';
        for await (const chunk of process.stdin) text += String(chunk);
      } finally {
        listener[Symbol.dispose]();
      }
    } else if (value.startsWith('@')) text = await readFile(source, { encoding: 'utf8', signal });
  } catch (cause) {
    throw new WorkflowCommandError(
      workflowFailure(
        'usage.input_file',
        `Could not read input from ${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { details: { source } },
      ),
    );
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // V8 reports an offset for ordinary syntax errors; truncated input fails at EOF.
    const match = /\bat position (\d+)(?: \(|$)/u.exec(message);
    const position = match ? Number(match[1]) : jsonErrorPosition(text);
    throw new WorkflowCommandError(
      workflowFailure(
        'usage.input_json',
        `--input must contain valid JSON. ${source}, position ${String(position)}: ${message}`,
        { details: { source, position } },
      ),
    );
  }
}
