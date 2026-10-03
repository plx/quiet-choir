/**
 * Error code that marks an output-limit failure. The runtime classifies any `Error` whose `code`
 * equals it as the `output-limit` error kind, across quiet-choir module instances, so an adapter
 * can report an exceeded byte budget without depending on an error class.
 */
export const outputLimitCode = 'QUIET_CHOIR_OUTPUT_LIMIT' as const;

/**
 * Create the error an adapter throws when native output exceeds a byte budget: a plain `Error`
 * whose `code` is {@link outputLimitCode}, which the runtime records as the `output-limit` kind
 * rather than as malformed protocol output. {@link runProcess} and {@link JsonLines} throw it for
 * their own limits.
 */
export function outputLimitError(message: string): Error & {
  /** Always {@link outputLimitCode}. */
  readonly code: typeof outputLimitCode;
} {
  return Object.assign(new Error(message), { code: outputLimitCode } as const);
}
