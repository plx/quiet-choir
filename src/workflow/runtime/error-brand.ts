/**
 * Structural identity for public error classes, following
 * [ADR 0028](../../../docs/decisions/0028-brand-public-errors-across-module-instances.md).
 *
 * `workflow execute` imports workflow code through tsx, which namespaces the workflow's whole
 * import graph, so workflow and custom-adapter code get their own copy of quiet-choir. Plain
 * `instanceof` fails across that boundary. A branded class recognizes an instance from any copy by
 * the class-name chain stored on its prototype under a registry symbol.
 */

/**
 * Registry key for a branded prototype's frozen class-name chain: the class's own name, then its
 * branded ancestors' names. It is a contract between quiet-choir copies. @internal
 */
export const ERROR_BRAND: unique symbol = Symbol.for('quiet-choir.error');

/** Registry key for a branded constructor's own class name, set only on the class itself. @internal */
export const ERROR_BRAND_NAME: unique symbol = Symbol.for('quiet-choir.error-name');

type ErrorConstructorLike = abstract new (...args: never[]) => unknown;

/**
 * Brand a class under `name`. Call it once from the class's static initialization block; the
 * inherited chain comes from the parent class's prototype, so a parent must be branded first.
 * Both properties are non-enumerable and never reach JSON, spreads or checkpoint records.
 * @internal
 */
export function brandError(constructor: ErrorConstructorLike, name: string): void {
  const parent: unknown = Object.getPrototypeOf(constructor);
  const inherited: unknown =
    typeof parent === 'function' ? Reflect.get(parent.prototype as object, ERROR_BRAND) : undefined;
  const chain = Object.freeze([
    name,
    ...(Array.isArray(inherited) ? inherited.filter((item) => typeof item === 'string') : []),
  ]);
  Object.defineProperty(constructor.prototype, ERROR_BRAND, { value: chain });
  Object.defineProperty(constructor, ERROR_BRAND_NAME, { value: name });
}

/**
 * `Symbol.hasInstance` for a branded class. The ordinary prototype check runs first, so a single
 * module instance behaves exactly as before. Otherwise only a class with its own brand name
 * accepts another copy's instance, and only when that instance's chain contains the name; a
 * subclass without its own brand keeps plain prototype semantics.
 * @internal
 */
export function isBranded(constructor: ErrorConstructorLike, value: unknown): boolean {
  if (Function.prototype[Symbol.hasInstance].call(constructor, value)) return true;
  if (!Object.hasOwn(constructor, ERROR_BRAND_NAME)) return false;
  if (typeof value !== 'object' || value === null) return false;
  const chain: unknown = Reflect.get(value, ERROR_BRAND);
  return Array.isArray(chain) && chain.includes(Reflect.get(constructor, ERROR_BRAND_NAME));
}
