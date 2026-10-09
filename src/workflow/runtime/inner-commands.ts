import type { Command, ExecResult, ExecSummary } from './exec-model.js';
import type { ErrorKind } from './model.js';

/** Most inner commands one parent attempt records; later ones are counted in `omitted`. @internal */
export const MAX_INNER_COMMANDS = 256;
/**
 * Most UTF-8 bytes of stdout plus stderr one parent attempt records across its inner commands.
 * @internal
 */
export const MAX_INNER_COMMAND_BYTES = 1_048_576;
/** Longest recorded message of an inner command that produced no result. @internal */
export const MAX_INNER_COMMAND_MESSAGE = 4096;

/** The raw process result an inner command got, before `okExitCodes` and schema checks. */
export interface InnerCommandResult {
  /** Exit code, or null when terminated by a signal. */
  readonly code: number | null;
  /** Termination signal, or null on ordinary exit. */
  readonly signal: string | null;
  /** Captured UTF-8 stdout, with head/tail retained on overflow. */
  readonly stdout: string;
  /** Captured UTF-8 stderr, with head/tail retained on overflow. */
  readonly stderr: string;
  /** Whether the runner cut the captured output. */
  readonly truncated: boolean;
}

/**
 * One command a step callback or poll observer ran through `context.exec`, in
 * {@link InnerCommands.commands}. Environment values and stdin are never stored, only the digests
 * that the command's identity and exec fixture rules use. Exactly one of `result` and `error` is
 * present.
 */
export interface InnerCommand {
  /** The argv list or `{ shell }` command, as prepared. */
  readonly command: Command;
  /** sha256 of the explicit environment edits, as in {@link ExecSummary.envSha256}. */
  readonly envSha256: string;
  /** sha256 of stdin, as in {@link ExecSummary.inputSha256}. */
  readonly inputSha256: string;
  /** Whether the command was an `exec.json` call. */
  readonly structured: boolean;
  /** Present and true for a poll observer's `live: true` command. */
  readonly live?: true;
  /** The raw process result, when the process runner returned one. */
  readonly result?: InnerCommandResult;
  /** Why the process runner returned no result: a spawn failure, timeout or cancellation. */
  readonly error?: InnerCommandError;
}

/** Why an inner command got no process result, in {@link InnerCommand.error}. */
export interface InnerCommandError {
  /** The failure's category, such as `process` for a spawn failure or `timeout`. */
  readonly kind: ErrorKind;
  /** The runner's error message, at most 4096 characters. */
  readonly message: string;
}

/**
 * The inner commands of a step's latest settled callback attempt, or of a wait's terminal poll
 * observation, in the step field `innerCommands`. Only `workflow fixtures` reads it, to export
 * exec rules; it is never an identity, replay or reuse input.
 */
export interface InnerCommands {
  /** The parent attempt that ran the commands (always 1 for a wait). */
  readonly attempt: number;
  /** A contiguous prefix of the commands, in the order they reached the process runner. */
  readonly commands: readonly InnerCommand[];
  /**
   * How many later commands were not recorded because the prefix reached 256 commands or 1 MiB
   * of stdout plus stderr. Absent when every command was recorded.
   */
  readonly omitted?: number;
}

interface Slot {
  readonly command: Omit<InnerCommand, 'result' | 'error'>;
  outcome?: Pick<InnerCommand, 'result' | 'error'>;
  bytes: number;
}

/**
 * Collects one parent attempt's inner commands within the bounds. A slot is reserved when a command
 * reaches the process runner, so the record keeps arrival order, which is the order exec fixture
 * rules count calls in. Recording stops at the first command that would pass a bound, so the kept
 * commands stay a contiguous prefix; content past the cut is dropped as soon as it is known.
 * @internal
 */
export class InnerCommandRecorder {
  readonly #slots: Slot[] = [];
  /** Commands reserved in all, including those past the cut. */
  #total = 0;
  /** Index of the first command not kept; only ever decreases. */
  #cut = MAX_INNER_COMMANDS;

  public constructor(private readonly attempt: number) {}

  /**
   * Reserve the next slot for a prepared command; call synchronously as the command reaches the
   * runner. Returns how to record its outcome.
   */
  public reserve(
    summary: Pick<ExecSummary, 'command' | 'envSha256' | 'inputSha256' | 'structured'>,
    live: boolean,
  ): {
    readonly resolved: (result: ExecResult) => void;
    readonly rejected: (kind: ErrorKind, message: string) => void;
  } {
    const index = this.#total++;
    if (index >= this.#cut) return { resolved: () => undefined, rejected: () => undefined };
    const slot: Slot = {
      command: {
        command: structuredClone(summary.command),
        envSha256: summary.envSha256,
        inputSha256: summary.inputSha256,
        structured: summary.structured,
        ...(live ? { live: true as const } : {}),
      },
      bytes: 0,
    };
    this.#slots.push(slot);
    return {
      resolved: (result) => {
        if (index >= this.#cut) return;
        slot.outcome = {
          result: {
            code: result.code,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          },
        };
        slot.bytes =
          Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8');
        this.#trim();
      },
      rejected: (kind, message) => {
        if (index >= this.#cut) return;
        slot.outcome = { error: { kind, message: message.slice(0, MAX_INNER_COMMAND_MESSAGE) } };
      },
    };
  }

  /** Move the cut to the first command whose output passes the byte bound, counting known output. */
  #trim(): void {
    let bytes = 0;
    for (let index = 0; index < this.#slots.length; index++) {
      bytes += this.#slots[index]?.bytes ?? 0;
      if (bytes > MAX_INNER_COMMAND_BYTES) {
        this.#cut = index;
        this.#slots.length = index;
        return;
      }
    }
  }

  /**
   * The recorded commands, or undefined when the attempt issued none. A slot still unsettled (its
   * runner never answered) ends the prefix like a bound.
   */
  public records(): InnerCommands | undefined {
    if (this.#total === 0) return undefined;
    const commands: InnerCommand[] = [];
    for (const slot of this.#slots) {
      if (!slot.outcome) break;
      commands.push({ ...slot.command, ...slot.outcome });
    }
    const omitted = this.#total - commands.length;
    return { attempt: this.attempt, commands, ...(omitted > 0 ? { omitted } : {}) };
  }
}
