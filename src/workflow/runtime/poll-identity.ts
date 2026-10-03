import type { JsonValue } from './model.js';

/**
 * Registry key under which a built-in helper hands a poll a stable identity value. Built-in helpers
 * only; it is not part of the public API. The value replaces the source text of the poll's
 * `observe` (or a command poll's `done`) in the wait's identity: the request's `observe` field
 * becomes the digest of `{ helper: value }`, so the helper's identity does not depend on how its
 * module was loaded or formatted. A helper must change the value (bump its version) whenever its
 * observation's meaning changes. A registry symbol keeps it working when the workflow's quiet-choir
 * import and the CLI's runtime are different module instances. @internal
 */
export const pollIdentityKey: unique symbol = Symbol.for('quiet-choir.poll-identity');

/** A poll source carrying a {@link pollIdentityKey} value; intersect it with the source. @internal */
export interface InternalPollIdentity {
  readonly [pollIdentityKey]?: JsonValue;
}
