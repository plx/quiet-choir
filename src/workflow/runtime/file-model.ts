/** Guarded UTF-8 write options. */
export interface WriteFileOptions {
  /** Null creates only; a SHA-256 requires that baseline. Desired content already present succeeds. */
  readonly ifMatch?: string | null;
  /** Explicitly permit paths outside the workflow directory, including symlink targets. */
  readonly allowOutsideCwd?: boolean;
}
/** Memoized UTF-8 read options. */
export interface ReadFileOptions {
  /** Maximum snapshot bytes, default 1048576; overflow fails without saving partial content. */
  readonly maxBytes?: number;
  /** Explicitly permit paths outside the workflow directory, including symlink targets. */
  readonly allowOutsideCwd?: boolean;
}
/** Hash-only receipt; the supplied write content is never stored in the effect record. */
export interface WriteFileResult {
  /** Absolute canonical target. */
  readonly path: string;
  /** SHA-256 of the written UTF-8 bytes. */
  readonly sha256: string;
  /** Byte length of the written content. */
  readonly bytes: number;
  /** Hash observed by this attempt before writing, or null for a missing file. */
  readonly previousSha256: string | null;
}
/** Saved text snapshot and the digest of its original bytes. */
export interface ReadFileResult {
  /** UTF-8 decoded content. */
  readonly content: string;
  /** SHA-256 of the original bytes. */
  readonly sha256: string;
}
