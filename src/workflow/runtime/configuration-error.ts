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

/** A spelling of the profile authoring surface that #726 removed. @internal */
export type RemovedProfileSurface = 'profiles' | 'defaults.profile' | 'call' | 'bind';

/**
 * The refusal of a removed profile spelling (#726, ADR 0063 section 4), naming `defineRoster` and
 * the roster that replace it. `subject` is the workflow name, or the step ID of a call. @internal
 */
export function removedProfileSurface(
  spelling: RemovedProfileSurface,
  subject = '',
): ConfigurationError {
  const tail = 'declare the agent with defineRoster and call ctx.roster.Name.';
  switch (spelling) {
    case 'profiles':
      return new ConfigurationError(
        `Workflow ${subject} declares profiles, which were removed (#726); declare agents with defineRoster, pass them as roster and call ctx.roster.Name.`,
      );
    case 'defaults.profile':
      return new ConfigurationError(
        `Workflow ${subject} sets defaults.profile, which was removed (#726); the default role is always text; declare agents with defineRoster and call ctx.roster.Name.`,
      );
    case 'call':
      return new ConfigurationError(
        `Step "${subject}": the profile call option was removed (#726); ${tail}`,
      );
    case 'bind':
      return new ConfigurationError(`bind cannot set profile; it was removed (#726): ${tail}`);
  }
}

/**
 * Whether `value` is an object with an own `key` that is not `undefined`, read through its
 * descriptor so no getter runs; a getter counts as set. @internal
 */
export function setsOwnKey(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && (!('value' in descriptor) || descriptor.value !== undefined);
}

/**
 * A call's role needs an access grant this run does not hold; raised only under `requireGrants`
 * (ADR 0063 §5). It is operator configuration, so it keeps {@link ConfigurationError}'s
 * never-settled, never-retried semantics; the runner reads its role (the `profile` field) and
 * access to choose a `--grant` recovery hint instead of parsing the message. The launch preflight
 * raises one error for every ungranted elevated role: `profile` and `access` are the first, and
 * `missing` lists them all.
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

  /** Every role this refusal names with the access it requires, starting with `profile`. */
  public readonly missing: readonly { readonly profile: string; readonly access: string }[];

  /** Name the role and the access it requires, and any other roles the same refusal names. */
  public constructor(
    /** Role (`text` or a roster entry) whose access is not granted. */
    public readonly profile: string,
    /** Access level the call requires, such as `write` or `exec`. */
    public readonly access: string,
    /**
     * Whether the call has call-site capability overrides, so a grant of its roster entry does not
     * admit it and only an access-class grant (`access` or `all`) does.
     */
    public readonly classOnly = false,
    /**
     * Whether the retry must repeat `--require-grants`: the layer came only from this invocation
     * and the run record could not keep it.
     */
    repeatRequireGrants = false,
    /**
     * The other ungranted roles the launch preflight found, in manifest order; a call-time refusal
     * names only its own role.
     */
    others: readonly { readonly profile: string; readonly access: string }[] = [],
  ) {
    const retry = repeatRequireGrants ? 'Retry with --require-grants and' : 'Retry with';
    const missing = [{ profile, access }, ...others];
    super(
      classOnly
        ? `Role ${profile} requires ${access} access for call-site capability overrides, which roster entry grants do not cover. ${retry} --grant ${access} or --grant all.`
        : missing.length === 1
          ? `Role ${profile} requires ${access} access. ${retry} --grant ${profile}, --grant ${access}, or --grant all.`
          : missingGrantsMessage(missing, retry),
    );
    this.name = 'GrantRequiredError';
    this.missing = missing;
  }
}

/**
 * The refusal text for several ungranted roles, grouped by access in first-seen order. Only write
 * and exec roles need a grant, and write does not cover exec, so the class grant it offers is the
 * highest class named.
 */
function missingGrantsMessage(
  missing: readonly { readonly profile: string; readonly access: string }[],
  retry: string,
): string {
  const byAccess = new Map<string, string[]>();
  for (const { profile, access } of missing)
    byAccess.set(access, [...(byAccess.get(access) ?? []), profile]);
  const clauses = [...byAccess].map(([access, names]) => {
    const last = names.pop() ?? '';
    return names.length
      ? `roles ${names.join(', ')} and ${last} require ${access} access`
      : `role ${last} requires ${access} access`;
  });
  const sentence = clauses.join(' and ');
  const level = byAccess.has('exec') ? 'exec' : 'write';
  const grants = missing.map(({ profile }) => `--grant ${profile}`).join(' ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. ${retry} ${grants}, --grant ${level}, or --grant all.`;
}
