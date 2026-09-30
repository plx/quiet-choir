import { brandError, isBranded } from './error-brand.js';

/**
 * A workflow or adapter misconfiguration discovered before an effect launches anything: for
 * example, a missing harness adapter, or a call that a harness adapter cannot run as configured
 * (a relative working directory or an output schema the provider cannot enforce).
 *
 * It is never a settled outcome or a retry target: like cancellation and checkpoint-write failures,
 * it always rejects and leaves the step unfinished, so correcting the configuration on resume can
 * still run the effect live. Harness adapters throw it for validation that fails before launch.
 */
export class ConfigurationError extends Error {
  static {
    brandError(this, 'ConfigurationError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is ConfigurationError {
    return isBranded(this, value);
  }

  /** Describe the misconfiguration; `options.cause` can carry the underlying validation error. */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}
