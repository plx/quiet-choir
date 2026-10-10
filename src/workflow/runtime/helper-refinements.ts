/**
 * Registry key under which a built-in helper marks its schema's custom refinements as integrity
 * checks that synthesized values satisfy. Built-in helpers only; it is not part of the public API.
 * A rehearsal skips the marked schema's subtree when it warns about custom Zod refinements, so
 * `quiet-choir/github` reads do not bury the warnings that matter; a refinement an author adds
 * around or beside a marked schema still warns. The marker is a non-enumerable symbol property,
 * so it never reaches the JSON Schema, a step's identity or a fingerprint. A registry symbol keeps
 * it working when the workflow's quiet-choir import and the CLI's runtime are different module
 * instances. @internal
 */
export const helperRefinementsKey: unique symbol = Symbol.for('quiet-choir.helper-refinements');

/**
 * Mark `schema` with {@link helperRefinementsKey} and return the same schema. Idempotent. A
 * non-extensible schema is left unmarked, so its warning still appears. @internal
 */
export function helperRefinements<S extends object>(schema: S): S {
  if (
    Object.isExtensible(schema) &&
    !Object.prototype.hasOwnProperty.call(schema, helperRefinementsKey)
  ) {
    Object.defineProperty(schema, helperRefinementsKey, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return schema;
}
