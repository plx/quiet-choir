import type { JsonValue } from '../workflow/runtime/model.js';

/** The prompt suffix and response extractor of {@link promptedStructuredOutput}. */
export interface PromptedStructuredOutput {
  /**
   * Text to append to the task prompt: it embeds the JSON Schema and asks for exactly one JSON
   * value, optionally in a json code fence. It starts with a blank line.
   */
  readonly instructions: string;
  /**
   * Find the JSON value in a model's answer and return it re-serialized, ready for
   * `HarnessResponse.text`. Accepts the whole answer as JSON, else the last json-tagged or untagged
   * code fence that parses, else the outermost `{...}` or `[...]` span. Throws a `SyntaxError`,
   * which the runtime classifies as `schema`, when the answer holds no JSON value. It does not
   * validate against the schema; the runtime does that with the step's Zod schema.
   */
  readonly extract: (text: string) => string;
}

const fence = /```([^\n`]*)\n([\s\S]*?)```/gu;

function parse(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function fenced(text: string): { readonly value: unknown } | undefined {
  const blocks = [...text.matchAll(fence)].filter((match) => {
    const tag = (match[1] ?? '').trim().toLowerCase();
    return tag === '' || tag === 'json';
  });
  for (const block of blocks.reverse()) {
    const parsed = parse((block[2] ?? '').trim());
    if (parsed) return parsed;
  }
  return undefined;
}

function span(text: string): { readonly value: unknown } | undefined {
  const candidates = (
    [
      ['{', '}'],
      ['[', ']'],
    ] as const
  )
    .map(([open, close]) => ({ start: text.indexOf(open), end: text.lastIndexOf(close) }))
    .filter(({ start, end }) => start >= 0 && end > start)
    .sort((a, b) => a.start - b.start);
  for (const { start, end } of candidates) {
    const parsed = parse(text.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * Structured output for a harness whose CLI cannot enforce a JSON Schema, advertised as
 * `capabilities: { structuredOutput: 'prompted' }`. The adapter appends `instructions` to the
 * prompt when `request.outputSchema` is not null, and returns `extract(answer)` as the response
 * text. The runtime then parses and validates that text exactly as it does for `'native'`
 * harnesses; it never rewrites prompts itself.
 */
export function promptedStructuredOutput(schema: JsonValue): PromptedStructuredOutput {
  const instructions = [
    '',
    '',
    'Respond with exactly one JSON value that conforms to the JSON Schema below, and nothing else.',
    'You may wrap the value in a ```json code fence. Do not add comments or trailing commas.',
    '',
    'JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
  return {
    instructions,
    extract: (text) => {
      const found = parse(text.trim()) ?? fenced(text) ?? span(text);
      if (found === undefined) throw new SyntaxError('The response contains no JSON value.');
      return JSON.stringify(found.value);
    },
  };
}
