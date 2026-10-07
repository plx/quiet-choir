/**
 * Most code points of a step error on a `step.failed` or `step.settled` event
 * (`WorkflowEvent.error`), counting the trailing ellipsis of a cut message. @internal
 */
export const STEP_EVENT_ERROR_MAX_CHARS = 500;

const FRAME_PREFIX = /^[ \t]+at /;
const LOCATION_END = /:\d+:\d+$/;

/**
 * Whether one line (without its `\n`) is a V8 stack-frame line. Each test is a linear, anchored
 * check, so adversarial error text cannot make it backtrack before the text is cut.
 */
function isV8FrameLine(line: string): boolean {
  const prefix = FRAME_PREFIX.exec(line);
  if (!prefix) return false;
  let end = line.endsWith('\r') ? line.length - 1 : line.length;
  while (end > prefix[0].length && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  const rest = line.slice(prefix[0].length, end);
  if (rest.endsWith(')')) {
    const open = rest.lastIndexOf('(');
    if (open < 0) return false;
    const location = rest.slice(open + 1, -1);
    return location === 'native' || location === '<anonymous>' || LOCATION_END.test(location);
  }
  const bare = rest.startsWith('async ')
    ? rest.slice('async '.length)
    : rest.startsWith('new ')
      ? rest.slice('new '.length)
      : rest;
  return bare.length > 0 && !/^\s/.test(bare) && LOCATION_END.test(bare);
}

/** The text before the first V8 stack-frame line, or all of it when there is none. */
function beforeFirstFrame(text: string): string {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    if (isV8FrameLine(text.slice(start, end))) return text.slice(0, start);
    if (newline < 0) break;
    start = newline + 1;
  }
  return text;
}

/**
 * The bounded, single-line form of a step's saved error text for event consumers: everything from
 * the first V8 stack-frame line onward is dropped (an indented `at fn (file:LINE:COL)`,
 * `at file:LINE:COL` (the path may contain spaces), `at fn (native)` or `at fn (<anonymous>)` line, with an optional `async` or
 * `new`; an ordinary line that merely starts with `at `, such as `at least one is required`, is
 * message text and stays), every whitespace run becomes one space, the result is trimmed, and text longer than {@link STEP_EVENT_ERROR_MAX_CHARS} code
 * points is cut at a code point to exactly that many including a trailing `…`. Returns undefined
 * when nothing remains. The full text and stack stay in the run record and `inspect`. @internal
 */
export function stepEventError(text: string | null | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const body = beforeFirstFrame(text).replace(/\s+/g, ' ').trim();
  if (!body) return undefined;
  const points = Array.from(body);
  if (points.length <= STEP_EVENT_ERROR_MAX_CHARS) return body;
  return `${points.slice(0, STEP_EVENT_ERROR_MAX_CHARS - 1).join('')}…`;
}
