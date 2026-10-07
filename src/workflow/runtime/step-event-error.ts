/**
 * Most code points of a step error on a `step.failed` or `step.settled` event
 * (`WorkflowEvent.error`), counting the trailing ellipsis of a cut message. @internal
 */
export const STEP_EVENT_ERROR_MAX_CHARS = 500;

/**
 * The bounded, single-line form of a step's saved error text for event consumers: everything from
 * the first V8 stack-frame line (`at ...`) onward is dropped, every whitespace run becomes one
 * space, the result is trimmed, and text longer than {@link STEP_EVENT_ERROR_MAX_CHARS} code
 * points is cut at a code point to exactly that many including a trailing `…`. Returns undefined
 * when nothing remains. The full text and stack stay in the run record and `inspect`. @internal
 */
export function stepEventError(text: string | null | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const frame = /^[ \t]*at\s/m.exec(text);
  const body = (frame ? text.slice(0, frame.index) : text).replace(/\s+/g, ' ').trim();
  if (!body) return undefined;
  const points = Array.from(body);
  if (points.length <= STEP_EVENT_ERROR_MAX_CHARS) return body;
  return `${points.slice(0, STEP_EVENT_ERROR_MAX_CHARS - 1).join('')}…`;
}
