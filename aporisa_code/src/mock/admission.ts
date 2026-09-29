// Bounded FIFO admission: `concurrency` active slots plus at most `maxQueue` waiters.

export type AdmissionResult = { ok: true; release: () => void } | { ok: false; code: "queue_full" | "queue_timeout" };

export class Admission {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number;

  constructor(options: { concurrency: number; maxQueue: number; queueTimeoutMs: number }) {
    this.concurrency = options.concurrency;
    this.maxQueue = options.maxQueue;
    this.queueTimeoutMs = options.queueTimeoutMs;
  }

  get activeCount(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<AdmissionResult> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve({ ok: true, release: this.releaser() });
    }
    if (this.waiters.length >= this.maxQueue) return Promise.resolve({ ok: false, code: "queue_full" });
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.active += 1;
        resolve({ ok: true, release: this.releaser() });
      };
      const leave = (code: "queue_timeout" | "queue_full") => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        clearTimeout(timer);
        resolve({ ok: false, code });
      };
      const timer = setTimeout(() => leave("queue_timeout"), this.queueTimeoutMs);
      signal?.addEventListener("abort", () => leave("queue_timeout"), { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
