import { outputLimitError } from '../processes/output-limit.js';

/** An output limit that must remain distinct from malformed native JSON. @internal */
export function retainedLimit(limit: number): Error {
  return outputLimitError(`Harness output exceeded maxRetainedBytes (${String(limit)} bytes).`);
}

/**
 * Byte-bounded newline framing for JSONL protocols, fed raw stdout chunks. Each complete line is
 * decoded as UTF-8 (a multi-byte character may span chunks) and awaited by `onLine` before the
 * next one, so a slow consumer applies backpressure through {@link runProcess}'s `stream.stdout`.
 * Blank lines are skipped; a trailing `\r` is left for the consumer, since `JSON.parse` ignores it.
 *
 * A line longer than `maxLineBytes` throws {@link outputLimitError}, unless `skipOversized` accepts
 * its first bytes (at most 8 KiB), in which case the whole line is discarded unparsed. Only accept
 * a prefix that proves the line is nonessential, such as a known native progress header.
 */
export class JsonLines {
  #buffer = Buffer.alloc(0);
  #length = 0;
  #skipping = false;
  readonly #limit: number;
  readonly #consume: (line: string) => void | Promise<void>;
  readonly #skip: (prefix: string) => boolean;

  /**
   * @param maxLineBytes - Largest line retained, from 1 to 2147483647 bytes.
   * @param onLine - Consumer of each nonblank line; a rejection rejects the `feed` call.
   * @param skipOversized - Decide from an oversized line's prefix whether to discard it; by
   *   default every oversized line is an output-limit failure.
   */
  public constructor(
    maxLineBytes: number,
    onLine: (line: string) => void | Promise<void>,
    skipOversized: (prefix: string) => boolean = () => false,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > 2_147_483_647)
      throw new Error('maxRetainedBytes must be a positive integer at most 2147483647.');
    this.#limit = maxLineBytes;
    this.#consume = onLine;
    this.#skip = skipOversized;
  }

  /** Frame one chunk, awaiting `onLine` for each line it completes. */
  public async feed(value: Uint8Array): Promise<void> {
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const end = newline < 0 ? chunk.length : newline;
      this.#append(chunk.subarray(cursor, end));
      if (newline >= 0) await this.#line();
      cursor = end + 1;
    }
  }

  /** Deliver a final line that had no trailing newline; call once after the last chunk. */
  public async finish(): Promise<void> {
    if (this.#length > 0 || this.#skipping) await this.#line();
  }

  #append(chunk: Buffer): void {
    if (this.#skipping) return;
    const size = this.#length + chunk.length;
    if (size > this.#limit) {
      const budget = Math.min(this.#limit, 8192);
      const prior = this.#buffer.subarray(0, Math.min(this.#length, budget));
      const prefix = Buffer.concat([prior, chunk.subarray(0, budget - prior.length)]);
      if (!this.#skip(prefix.toString('utf8'))) throw retainedLimit(this.#limit);
      this.#skipping = true;
      this.#length = 0;
      this.#buffer = Buffer.alloc(0);
      return;
    }
    if (size > this.#buffer.length) {
      const capacity = Math.min(
        this.#limit,
        Math.max(size, Math.min(65536, this.#limit), this.#buffer.length * 2),
      );
      const next = Buffer.allocUnsafe(capacity);
      this.#buffer.copy(next, 0, 0, this.#length);
      this.#buffer = next;
    }
    chunk.copy(this.#buffer, this.#length);
    this.#length = size;
  }

  async #line(): Promise<void> {
    if (!this.#skipping) {
      const line = this.#buffer.subarray(0, this.#length).toString('utf8');
      this.#length = 0;
      if (line.trim()) await this.#consume(line);
    }
    this.#length = 0;
    this.#skipping = false;
  }
}

/** Former name of {@link JsonLines}, kept for internal callers. @internal */
export const ProtocolLines: typeof JsonLines = JsonLines;

const codexHeader =
  /^\s*\{\s*"type"\s*:\s*"(item\.(?:started|updated|completed))"\s*,\s*"item"\s*:\s*\{\s*(?:"id"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*)?"type"\s*:\s*"(command_execution|reasoning|file_change|mcp_tool_call|web_search|todo_list)"\s*[,}]/u;

/** The event, item ID and item type of a recognized Codex item header, from a bounded prefix. @internal */
export function codexItemHeader(
  prefix: string,
): { readonly event: string; readonly id: string | undefined; readonly type: string } | undefined {
  const match = codexHeader.exec(prefix);
  if (!match) return undefined;
  let id = match[2];
  if (id !== undefined) {
    try {
      id = JSON.parse(id) as string;
    } catch {
      // An undecodable ID keeps its raw spelling; it only has to match its own completion.
    }
  }
  return { event: match[1] ?? '', id, type: match[3] ?? '' };
}

/** Only recognize the native outer header, never type-like text inside command output. @internal */
export function irrelevantLine(harness: 'claude' | 'codex', prefix: string): boolean {
  if (harness === 'claude')
    return (
      /^\s*\{\s*"type"\s*:\s*"(?:assistant|user)"\s*[,}]/u.test(prefix) ||
      /^\s*\{\s*"type"\s*:\s*"system"\s*,\s*"subtype"\s*:\s*"(?:commands_changed|hook_started|hook_progress|hook_response|session_state_changed)"\s*[,}]/u.test(
        prefix,
      )
    );
  return codexHeader.test(prefix);
}
