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
   * code fence that parses, else the first balanced `{...}` or `[...]` value that parses. That
   * fallback tries every bracket as a start, matching its close by nesting depth outside JSON
   * strings, so prose like `{not JSON}` before the object is skipped. It tries the delimiter that
   * matches the schema's top-level `type` first (`{` for `object`, `[` for `array`), so a citation
   * like `[1]` before the object is skipped too; with no such type it takes the earliest value
   * that parses. Throws a `SyntaxError`, which the runtime classifies as `schema`,
   * when the answer holds no JSON value. It does not validate against the schema; the runtime
   * does that with the step's Zod schema.
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

/**
 * The end index of the bracketed value opening at `start`: the close that brings the nesting depth
 * back to zero, skipping brackets inside JSON strings. Returns -1 when the text ends first.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function span(text: string, preferred?: '{' | '['): { readonly value: unknown } | undefined {
  const starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{' || text[index] === '[') starts.push(index);
  }
  starts.sort((a, b) => {
    if (preferred !== undefined && text[a] !== text[b]) return text[a] === preferred ? -1 : 1;
    return a - b;
  });
  for (const start of starts) {
    const end = balancedEnd(text, start);
    if (end < 0) continue;
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
  const type =
    typeof schema === 'object' && schema !== null && !Array.isArray(schema)
      ? schema['type']
      : undefined;
  const preferred = type === 'object' ? '{' : type === 'array' ? '[' : undefined;
  return {
    instructions,
    extract: (text) => {
      const found = parse(text.trim()) ?? fenced(text) ?? span(text, preferred);
      if (found === undefined) throw new SyntaxError('The response contains no JSON value.');
      return JSON.stringify(found.value);
    },
  };
}
