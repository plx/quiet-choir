import type { JsonValue } from './model.js';

/** Retain every transcript, only failed attempts, or no transcripts. */
export type TranscriptMode = 'on' | 'on-failure' | 'off';

/** Extensible diagnostic data; individual keys never participate in replay identity. */
export type AgentDiagnostics = Readonly<Record<string, JsonValue>>;

/** A bounded, lossy observation of native activity, never a durable transition. */
export interface AgentProgress {
  /** Native initialization, tool activity, message, or status. */
  readonly kind: 'init' | 'tool' | 'message' | 'status';
  /**
   * Short description, without full tool inputs or command output. A tool summary may end with a
   * short, bounded target, such as a file path, the head of a command, a search pattern or query,
   * or an MCP `server/tool` name; built-in adapters take it only from allowlisted input fields,
   * bound it to 80 code points and strip URL queries. Treat it as lossy free text.
   */
  readonly summary: string;
  /** Native model name, when reported. */
  readonly model?: string;
  /** Native CLI version, when reported. */
  readonly cliVersion?: string;
}

/** Private, bounded raw-output artifact for one attempt. */
export interface AgentTranscript {
  /** Storage-selected artifact location; FileRunStore uses an absolute private run path. */
  readonly path: string;
  /** Bytes written, including the truncation marker. */
  readonly bytes: number;
  /** Whether output exceeded the transcript cap. */
  readonly truncated: boolean;
  /** False after successful on-failure retention cleanup. */
  readonly retained: boolean;
}

/** Owned transcript storage port; the runtime awaits writes and closes every started attempt. */
export interface AgentTranscriptWriter {
  /** Return a detached receipt for checkpointing, without raw output. */
  snapshot(): AgentTranscript;
  /** Retain raw output within the file cap; reject storage failures and apply backpressure. */
  write(stream: 'stdout' | 'stderr', chunk: Uint8Array): Promise<void>;
  /** Drain writes and release resources; repeated calls must be safe. */
  close(): Promise<void>;
  /** Remove a closed successful transcript; called only after its outcome commits. */
  discard(): Promise<void>;
}
