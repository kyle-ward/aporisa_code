// Push-based async queue bridging callback APIs (WebSocket) to async iteration.

export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }[] = [];
  private ended = false;
  private failure: { error: unknown } | null = null;

  push(item: T): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.ended || this.failure) return;
    this.failure = { error };
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.failure) return Promise.reject(this.failure.error);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}
