/**
 * Shared plumbing for the std patterns; `CallDefaults` is re-exported from `std.patterns`.
 *
 * @module
 */
import type { BoundCallOptions } from '../index.js';

/** Options applied to every agent call a pattern makes; the pattern sets the prompt, schema and error mode. */
export type CallDefaults = Omit<BoundCallOptions, 'prompt' | 'onError'>;
