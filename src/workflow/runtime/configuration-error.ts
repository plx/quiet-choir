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

/**
 * A profile call needs an access grant this run does not hold. It is operator configuration, so it
 * keeps {@link ConfigurationError}'s never-settled, never-retried semantics; the runner reads its
 * profile and access to choose a `--grant` recovery hint instead of parsing the message.
 * @internal
 */
export class GrantRequiredError extends ConfigurationError {
  static {
    brandError(this, 'GrantRequiredError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is GrantRequiredError {
    return isBranded(this, value);
  }

  /** Name the profile and the access it requires. */
  public constructor(
    /** Profile whose access is not granted. */
    public readonly profile: string,
    /** Access level the call requires, such as `write` or `exec`. */
    public readonly access: string,
  ) {
    super(
      `Profile ${profile} requires ${access} access. Retry with --grant ${profile}, --grant ${access}, or --grant all.`,
    );
    this.name = 'GrantRequiredError';
  }
}
