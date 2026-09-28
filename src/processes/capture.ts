import { StringDecoder } from 'node:string_decoder';

/** Grow `buffer` to hold at least `needed` bytes, doubling up to `cap`, keeping `used` bytes. */
function grow(
  buffer: Buffer<ArrayBuffer>,
  used: number,
  needed: number,
  cap: number,
): Buffer<ArrayBuffer> {
  if (needed <= buffer.length) return buffer;
  const next = Buffer.alloc(Math.min(cap, Math.max(needed, buffer.length * 2)));
  buffer.copy(next, 0, 0, used);
  return next;
}

/**
 * Bounded byte capture preserving both the beginning and the end of a stream. Each append copies
 * only its own bytes: the head fills a growing buffer and the tail wraps around a ring.
 */
export class OutputCapture {
  readonly #limit: number;
  readonly #headLimit: number;
  #head = Buffer.alloc(0);
  #headLength = 0;
  #ring = Buffer.alloc(0);
  #ringStart = 0;
  #tailLength = 0;
  #bytes = 0;

  public constructor(limit: number) {
    this.#limit = limit;
    this.#headLimit = Math.ceil(limit / 2);
  }

  public append(chunk: Buffer): void {
    this.#bytes += chunk.length;
    const take = Math.min(chunk.length, this.#headLimit - this.#headLength);
    if (take > 0) {
      this.#head = grow(this.#head, this.#headLength, this.#headLength + take, this.#headLimit);
      chunk.copy(this.#head, this.#headLength, 0, take);
      this.#headLength += take;
    }
    const tailLimit = this.#limit - this.#headLimit;
    if (tailLimit === 0 || take === chunk.length) return;
    const remainder = chunk.subarray(Math.max(take, chunk.length - tailLimit));
    if (this.#tailLength + remainder.length > this.#ring.length && this.#ring.length < tailLimit) {
      // Before the ring reaches its full size it has never wrapped, so its bytes start at 0.
      this.#ring = grow(
        this.#ring,
        this.#tailLength,
        this.#tailLength + remainder.length,
        tailLimit,
      );
    }
    const capacity = this.#ring.length;
    const end = (this.#ringStart + this.#tailLength) % capacity;
    const first = Math.min(remainder.length, capacity - end);
    remainder.copy(this.#ring, end, 0, first);
    remainder.copy(this.#ring, 0, first);
    const total = this.#tailLength + remainder.length;
    if (total > capacity) this.#ringStart = (this.#ringStart + total - capacity) % capacity;
    this.#tailLength = Math.min(total, capacity);
  }

  public get truncated(): boolean {
    return this.#bytes > this.#limit;
  }

  public text(): string {
    const head = this.#head.subarray(0, this.#headLength);
    const tail = this.#tail();
    if (!this.truncated) return Buffer.concat([head, tail]).toString('utf8');
    // Do not invent replacement characters where the retained head/tail split a UTF-8 sequence.
    let start = 0;
    while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
    return new StringDecoder('utf8').write(head) + tail.subarray(start).toString('utf8');
  }

  /** The retained tail bytes in stream order. */
  #tail(): Buffer {
    const end = this.#ringStart + this.#tailLength;
    if (end <= this.#ring.length) return this.#ring.subarray(this.#ringStart, end);
    return Buffer.concat([
      this.#ring.subarray(this.#ringStart),
      this.#ring.subarray(0, end - this.#ring.length),
    ]);
  }
}
