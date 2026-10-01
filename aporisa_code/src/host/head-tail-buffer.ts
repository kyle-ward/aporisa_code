// Keeps the first and last bytes of a stream within a fixed budget, counting what is
// dropped from the middle (codex core/src/unified_exec/head_tail_buffer.rs).

export interface HeadTailSnapshot {
  head: Uint8Array;
  tail: Uint8Array;
  totalBytes: number;
  omittedBytes: number;
}

export class HeadTailBuffer {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head: Uint8Array[] = [];
  private headBytes = 0;
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private totalBytes = 0;
  private omittedBytes = 0;

  constructor(maxBytes: number) {
    this.headBudget = Math.floor(maxBytes / 2);
    this.tailBudget = maxBytes - this.headBudget;
  }

  get size(): number {
    return this.totalBytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.totalBytes += chunk.byteLength;
    let rest = chunk;
    const headRoom = this.headBudget - this.headBytes;
    if (headRoom > 0) {
      const taken = rest.subarray(0, headRoom);
      this.head.push(taken);
      this.headBytes += taken.byteLength;
      rest = rest.subarray(taken.byteLength);
    }
    if (rest.byteLength === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.byteLength;
    while (this.tailBytes > this.tailBudget) {
      const first = this.tail[0];
      if (!first) break;
      const excess = this.tailBytes - this.tailBudget;
      if (first.byteLength <= excess) {
        this.tail.shift();
        this.tailBytes -= first.byteLength;
        this.omittedBytes += first.byteLength;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.omittedBytes += excess;
      }
    }
  }

  /** Returns everything kept so far and starts a new interval. */
  take(): HeadTailSnapshot {
    const snapshot = {
      head: concat(this.head, this.headBytes),
      tail: concat(this.tail, this.tailBytes),
      totalBytes: this.totalBytes,
      omittedBytes: this.omittedBytes,
    };
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.totalBytes = 0;
    this.omittedBytes = 0;
    return snapshot;
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
