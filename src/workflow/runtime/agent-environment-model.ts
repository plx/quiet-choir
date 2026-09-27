/** Explicit environment edits, applied after host-session scrubbing. */
export interface EnvironmentEdits {
  /** Values enter semantic identity; inherit rotating credentials instead. */
  readonly set?: Readonly<Record<string, string>>;
  /** Remove these names from the child environment. */
  readonly unset?: readonly string[];
}

/** Structured edits, with the original flat set-only overlay retained for compatibility. */
export type AgentEnvironment = EnvironmentEdits | Readonly<Record<string, string>>;

/** Environment diagnostics contain names and a digest, never explicit values. */
export interface EnvironmentSummary {
  /** SHA-256 of canonical explicit edits. */
  readonly sha256: string;
  /** Explicitly assigned names. */
  readonly set: readonly string[];
  /** Explicitly removed names. */
  readonly unset: readonly string[];
}

/** Host observations are diagnostic only; inherited values never enter fingerprints. */
export interface HostEnvironmentSummary {
  /** Behavior-changing variable names present in the parent environment. */
  readonly variables: readonly string[];
  /** Present host-session variable names removed by the adapter's scrub policy. */
  readonly scrubbed: readonly string[];
}
