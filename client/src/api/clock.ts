// Time as a dependency, so reconnect backoff, dead-connection detection and announcement
// throttling can be tested without waiting and without global fake timers.

export interface Clock {
  now(): number;
  /** Runs `callback` once, `ms` from now. The returned function cancels it if it has not run. */
  schedule(callback: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(callback, ms) {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
};

interface Pending {
  readonly due: number;
  readonly order: number;
  readonly callback: () => void;
}

/**
 * A clock that only moves when told to. For tests and the fake store: `advance` runs every callback
 * that falls due, in due order, including ones scheduled by callbacks while advancing.
 */
export class ManualClock implements Clock {
  private time: number;
  private order = 0;
  private readonly pending = new Set<Pending>();

  constructor(start = Date.UTC(2026, 9, 10, 12, 0, 0)) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  schedule(callback: () => void, ms: number): () => void {
    const entry: Pending = { due: this.time + Math.max(0, ms), order: this.order++, callback };
    this.pending.add(entry);
    return () => {
      this.pending.delete(entry);
    };
  }

  /** How many callbacks are waiting. */
  get scheduled(): number {
    return this.pending.size;
  }

  /** Delays of the waiting callbacks from now, soonest first. */
  get delays(): number[] {
    return [...this.pending].map((entry) => entry.due - this.time).sort((a, b) => a - b);
  }

  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      let next: Pending | undefined;
      for (const entry of this.pending) {
        if (entry.due <= until && (!next || entry.due < next.due || (entry.due === next.due && entry.order < next.order))) next = entry;
      }
      if (!next) break;
      this.pending.delete(next);
      this.time = next.due;
      next.callback();
    }
    this.time = until;
  }
}
