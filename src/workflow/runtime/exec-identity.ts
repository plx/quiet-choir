import type { JsonValue } from './model.js';

/**
 * Registry key under which a built-in helper hands an exec step a stable identity value. Built-in
 * helpers only; it is not part of the public API. The value replaces the argv in the step's
 * identity under the component key `helper`, while the argv is still executed and recorded. A
 * registry symbol keeps it working when the workflow's quiet-choir import and the CLI's runtime are
 * different module instances. @internal
 */
export const execIdentityKey: unique symbol = Symbol.for('quiet-choir.exec-identity');

/** Options carrying an {@link execIdentityKey} value; intersect it with `ExecOptions`. @internal */
export interface InternalExecIdentity {
  readonly [execIdentityKey]?: JsonValue;
}
