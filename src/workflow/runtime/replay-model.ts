/** Engine compatibility information independent of workflow sources. */
export interface EngineInfo {
  /** Installed quiet-choir package version. */
  readonly version: string;
  /** Checkpoint contract version. */
  readonly formatVersion: number;
}

/** Canonical workflow source hashes supplied by the loader or an embedded caller. */
export interface SourceFingerprint {
  /** Digest of the relative-path file map. */
  readonly hash: string;
  /** Real files named relative to the workflow project root, with SHA-256 content hashes. */
  readonly files: Readonly<Record<string, string>>;
}

/** Components used for run compatibility and actionable drift reports. */
export interface WorkflowIdentity {
  /** Source digest, or null when the caller supplies no code identity. */
  readonly code: string | null;
  /** Per-file content hashes, empty for opaque embedded fingerprints. */
  readonly files: Readonly<Record<string, string>>;
  /** Input JSON Schema digest. */
  readonly inputSchema: string;
  /** Output JSON Schema digest. */
  readonly outputSchema: string;
  /** Engine version and checkpoint contract. */
  readonly engine: EngineInfo;
}

/** Explicit reuse source for a new run. Source checkpoints are never modified. */
export interface ForkOptions {
  /** Source run identifier. The target must be a different checkpoint. */
  readonly runId: string;
  /** Source storage; defaults to the target's state directory. */
  readonly stateDir?: string;
  /**
   * Reuse unchanged effects whose possible causes were reused too (the default), or explicitly reuse
   * all matching effects. See ADR 0006.
   */
  readonly reuse?: 'prefix' | 'matching';
  /** Step-ID globs that must execute live, using * within segments and ** across them. */
  readonly invalidate?: readonly string[];
}

/** Saved provenance and reuse progress for a fork. */
export interface ForkProvenance {
  /** Source run identifier. */
  readonly runId: string;
  /** Absolute source checkpoint directory. */
  readonly stateDir: string;
  /** Digest pinning the source snapshot used when the fork began. */
  readonly sourceDigest: string;
  /** Original source workflow fingerprint. */
  readonly fingerprint: string | null;
  /** Selected reuse mode. */
  readonly reuse: 'prefix' | 'matching';
  /** Explicit invalidation globs. */
  readonly invalidate: readonly string[];
  /** Components intentionally different from the source run. */
  readonly differences: readonly string[];
  /** Time at which the fork was created. */
  readonly at: string;
  /**
   * Number of source effects reused by prefix reuse. Builds before #145 used it as a position in
   * source launch order; it no longer drives reuse.
   */
  cursor: number;
  /**
   * True when reuse is closed for the whole fork: the pinned source snapshot changed or became
   * unavailable, or a build before #145 closed it on a prefix miss. A prefix miss no longer sets it.
   */
  reuseClosed: boolean;
  /** Reason reuse was closed because the source changed or became unavailable. */
  warning?: string;
}

/** Original checkpoint supplying a copied completed effect. */
export interface ReusedStep {
  /** Source run identifier. */
  readonly runId: string;
  /** Absolute source checkpoint directory. */
  readonly stateDir: string;
  /** Source effect identifier. */
  readonly stepId: string;
  /** Source effect fingerprint. */
  readonly fingerprint: string;
  /** ISO reuse timestamp. */
  readonly at: string;
}

/**
 * An explicitly accepted code/schema change. A run-level entry records the workflow fingerprint
 * change; a map entry (with `map` set) records one settled map that accepted a mapper-only change.
 * The two are recorded independently.
 */
export interface CodeChange {
  /** ISO acceptance timestamp. */
  readonly at: string;
  /** Previous full workflow fingerprint, or the map's previous aggregate fingerprint when `map` is set. */
  readonly from: string | null;
  /** Newly accepted full workflow fingerprint, or the map's new aggregate fingerprint when `map` is set. */
  readonly to: string;
  /** Files added, removed, or changed; empty for a map entry. */
  readonly files: readonly string[];
  /** Changed compatibility components, including schemas; `['mapper']` for a map entry. */
  readonly components: readonly string[];
  /** The settled map journal ID whose mapper change was accepted; absent for a run-level entry. */
  readonly map?: string;
}

/** A lock-free run compatibility report; it does not execute or preview the workflow body. */
export interface ResumeCheck {
  /** Whether the selected strict/accept-code-change mode passes run-level gates. */
  readonly compatible: boolean;
  /** Components that differ from the checkpoint. */
  readonly changed: readonly string[];
  /** Components confirmed unchanged. */
  readonly unchanged: readonly string[];
  /** Added, removed, or changed source files. */
  readonly files: readonly string[];
  /** Current full workflow fingerprint, also reported by validate and stored in new runs. */
  readonly fingerprint: string;
  /** Checkpoint workflow fingerprint. */
  readonly savedFingerprint: string | null;
  /** Whether explicit code/schema acceptance can satisfy the run-level gates. */
  readonly canAcceptCodeChange: boolean;
  /** Whether every recorded effect completed before a failed run ended. */
  readonly refinalizable: boolean;
  /** Human-readable diagnosis and recovery choices. */
  readonly message: string;
}
