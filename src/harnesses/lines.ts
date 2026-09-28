/** An output limit that must remain distinct from malformed native JSON. @internal */
export function retainedLimit(limit: number): Error {
  return Object.assign(
    new Error(`Harness output exceeded maxRetainedBytes (${String(limit)} bytes).`),
    {
      code: 'QUIET_CHOIR_OUTPUT_LIMIT',
    },
  );
}

/** Byte-bounded JSONL framing; a known irrelevant oversized line can be discarded. @internal */
export class ProtocolLines {
  #buffer = Buffer.alloc(0);
  #length = 0;
  #skipping = false;
  readonly #limit: number;
  readonly #consume: (line: string) => void | Promise<void>;
  readonly #skip: (prefix: string) => boolean;

  public constructor(
    limit: number,
    consume: (line: string) => void | Promise<void>,
    skip: (prefix: string) => boolean,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647)
      throw new Error('maxRetainedBytes must be a positive integer at most 2147483647.');
    this.#limit = limit;
    this.#consume = consume;
    this.#skip = skip;
  }

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

/** Only recognize the native outer header, never type-like text inside command output. @internal */
export function irrelevantLine(provider: 'claude' | 'codex', prefix: string): boolean {
  if (provider === 'claude')
    return (
      /^\s*\{\s*"type"\s*:\s*"(?:assistant|user)"\s*[,}]/u.test(prefix) ||
      /^\s*\{\s*"type"\s*:\s*"system"\s*,\s*"subtype"\s*:\s*"(?:commands_changed|hook_started|hook_progress|hook_response|session_state_changed)"\s*[,}]/u.test(
        prefix,
      )
    );
  return /^\s*\{\s*"type"\s*:\s*"item\.(?:started|updated|completed)"\s*,\s*"item"\s*:\s*\{\s*(?:"id"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"type"\s*:\s*"(?:command_execution|reasoning|file_change|mcp_tool_call|web_search|todo_list)"\s*[,}]/u.test(
    prefix,
  );
}
