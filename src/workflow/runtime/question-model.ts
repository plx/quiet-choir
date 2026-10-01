import type { z } from 'zod';
import type { JsonValue } from './model.js';

/** A durable question whose answer is supplied through the run's inbox. */
export interface AskOptions<T> {
  /** One-line question, at most 1024 characters. */
  readonly prompt: string;
  /** Authoritative answer schema; refinements are checked by the running workflow. */
  readonly schema: z.ZodType<T>;
  /** Markdown context, at most 16 KiB of UTF-8. */
  readonly details?: string;
  /** Up to four suggested answers; free-form answers must still satisfy the schema. */
  readonly choices?: readonly QuestionChoice<NoInfer<T>>[];
  /** Routing hint, not authentication; defaults to any. */
  readonly audience?: 'human' | 'agent' | 'any';
  /** The revision or artifact being decided, included in the fingerprint. */
  readonly subject?: JsonValue;
  /** Short question-tool header, at most 12 characters. */
  readonly title?: string;
}

/** A suggested answer presented to an operator. */
export interface QuestionChoice<T = JsonValue> {
  /** Schema-valid answer value. */
  readonly value: T;
  /** Display label, at most 100 characters. */
  readonly label: string;
  /** Optional explanation, at most 1024 characters. */
  readonly description?: string | undefined;
}

/** A decision with optional operator context. */
export interface Approval {
  /** Whether the specified subject is approved. */
  readonly approved: boolean;
  /** Untrusted operator explanation. */
  readonly comment?: string | undefined;
}

/** Approval presentation and identity, with a fixed answer schema. */
export type ApproveOptions = Omit<AskOptions<Approval>, 'schema' | 'choices'>;

/** Persisted question content, with absent optional values normalized to null. */
export interface QuestionRequest {
  /** One-line question. */
  readonly prompt: string;
  /** Markdown context or null. */
  readonly details: string | null;
  /** Suggested answers in presentation order. */
  readonly choices: readonly QuestionChoice[];
  /** Routing hint, enforced only through a self-asserted attribution. */
  readonly audience: 'human' | 'agent' | 'any';
  /** Revision or artifact identity. */
  readonly subject: JsonValue;
  /** Short display header or null. */
  readonly title: string | null;
  /** Draft-7 schema used for early, code-free validation. */
  readonly schema: JsonValue;
}

/** Persisted attribution for an accepted answer. */
export interface QuestionResolution {
  /** Delivery channel. */
  readonly via: 'inbox';
  /** Self-asserted author; filesystem access is the trust boundary. */
  readonly by: string;
  /** Delivery timestamp supplied by the writer. */
  readonly at: string;
}

/** An inbox delivery rejected by the authoritative workflow schema. */
export interface QuestionRejection {
  /** Ingestion timestamp. */
  readonly at: string;
  /** Validation explanation, bounded to 4096 characters. */
  readonly error: string;
  /** Quarantined filename in the inbox. */
  readonly file: string;
}

/** Durable state specific to an ask effect. */
export interface QuestionRecord {
  /** Fingerprinted presentation and validation contract. */
  readonly request: QuestionRequest;
  /** First registration timestamp, retained across resumes. */
  readonly askedAt: string;
  /** Accepted attribution, or null while unanswered. */
  resolution: QuestionResolution | null;
  /** Most recent 20 rejected deliveries; files remain available for audit. */
  rejections: QuestionRejection[];
}

/** A checkpoint-only view suitable for a human-question tool. */
export interface PendingQuestion extends QuestionRequest {
  /** Owning run. */
  readonly runId: string;
  /** Fully qualified durable effect ID. */
  readonly stepId: string;
  /** Fingerprint required on inbox deliveries. */
  readonly questionFingerprint: string;
  /** First registration timestamp. */
  readonly askedAt: string;
  /** Most recent rejected deliveries. */
  readonly rejections: readonly QuestionRejection[];
  /** Whether recorded source bytes changed; null when no source paths were saved. */
  readonly codeChanged: boolean | null;
  /** Argument vector; replace ANSWER_JSON with serialized data. Null in a disposed CLI rehearsal. */
  readonly answerCommand: readonly string[] | null;
}

/** Optional source launch metadata; core execution never imports these paths. */
export interface WorkflowLaunch {
  /** Absolute workflow module path. */
  readonly entrypoint: string;
  /** Absolute tsconfig path or null for built-in compiler defaults. */
  readonly tsconfig: string | null;
  /** Absolute source paths mapped to their SHA-256 hashes, for code-free drift checks. */
  readonly sources?: Readonly<Record<string, string>>;
  /**
   * Non-secret launch policy of the latest CLI execution, which a resume by ID without explicit
   * flags inherits. Absent in older checkpoints and in launches an embedder supplies.
   */
  readonly policy?: LaunchPolicy;
}

/**
 * The CLI's harness selection and wait mode, replaced on every execution and outside step identity.
 * It never holds CLI harness configuration values (only their digest is recorded, on
 * `RunRecord.harness.configDigest`).
 */
export interface LaunchPolicy {
  /** Global harness kind and the fixture files the selection read. */
  readonly harness: {
    /** `cli` for the native CLIs, or `fixture` when a global fixture file answers agent calls. */
    readonly kind: 'cli' | 'fixture';
    /**
     * Fixture files by absolute path with the SHA-256 of their bytes. An entry without a name is the
     * global fixture, present exactly when `kind` is `fixture`; a named entry selects
     * `name=fixture:<file>`.
     */
    readonly fixtures?: readonly {
      readonly name?: string;
      readonly path: string;
      readonly sha256: string;
    }[];
  };
  /** Whether long waits suspend the run or keep waiting in the process. */
  readonly waitMode: 'suspend' | 'block';
}
