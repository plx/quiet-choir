import { StringDecoder } from 'node:string_decoder';

/** Bounded byte capture preserving both the beginning and the end of a stream. */
export class OutputCapture {
  readonly #limit: number;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #bytes = 0;

  public constructor(limit: number) {
    this.#limit = limit;
  }

  public append(chunk: Buffer): void {
    this.#bytes += chunk.length;
    const headLimit = Math.ceil(this.#limit / 2);
    const take = Math.min(chunk.length, headLimit - this.#head.length);
    if (take > 0) this.#head = Buffer.concat([this.#head, chunk.subarray(0, take)]);
    const remainder = chunk.subarray(take);
    const tailLimit = this.#limit - headLimit;
    if (tailLimit === 0 || remainder.length === 0) return;
    this.#tail =
      remainder.length >= tailLimit
        ? Buffer.from(remainder.subarray(-tailLimit))
        : Buffer.concat([
            this.#tail.subarray(Math.max(0, this.#tail.length + remainder.length - tailLimit)),
            remainder,
          ]);
  }

  public get truncated(): boolean {
    return this.#bytes > this.#limit;
  }

  public text(): string {
    if (!this.truncated) return Buffer.concat([this.#head, this.#tail]).toString('utf8');
    // Do not invent replacement characters where the retained head/tail split a UTF-8 sequence.
    const head = new StringDecoder('utf8').write(this.#head);
    let start = 0;
    while (start < this.#tail.length && ((this.#tail[start] ?? 0) & 0xc0) === 0x80) start++;
    return head + this.#tail.subarray(start).toString('utf8');
  }
}
