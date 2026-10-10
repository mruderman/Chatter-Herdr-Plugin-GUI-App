// The text of the polite "Announcements" region (UI contract section 3), throttled and worded as
// the fake store does it (fake.ts, announce and flush), which is what the views are tested against.
import type { Clock } from '../api/clock';
import { CHANNEL, type Message } from '../api/types';
import type { Announcement } from './types';

export const ANNOUNCE_EVERY_MS = 3_000;
export const ANNOUNCE_CHARS = 140;

interface Pending {
  readonly message: Message;
  /** The label of the message's conversation when it arrived. */
  readonly label: string;
}

export class Announcer {
  private queue: Pending[] = [];
  // Kept across reset(): a sign-out and a quick sign-in must not let two announcements through within 3 s.
  private lastAt = Number.NEGATIVE_INFINITY;
  private cancel: (() => void) | null = null;
  private latest: Announcement | null = null;

  /** `onLater` runs when a held burst is released by the clock, so the store can publish it. */
  constructor(private readonly clock: Clock, private readonly onLater: () => void) {}

  get current(): Announcement | null {
    return this.latest;
  }

  /** Someone else's message in the selected repo. Announced now, or held until 3 s after the last one. */
  add(message: Message, label: string): void {
    this.queue.push({ message, label });
    const wait = this.lastAt + ANNOUNCE_EVERY_MS - this.clock.now();
    if (wait <= 0) {
      this.cancel?.();
      this.cancel = null;
      this.flush();
    } else if (!this.cancel) {
      this.cancel = this.clock.schedule(() => {
        this.cancel = null;
        this.flush();
        this.onLater();
      }, wait);
    }
  }

  /** Drops what is held, as when another repo is selected; the last announcement stays. */
  drop(): void {
    this.queue = [];
    this.cancel?.();
    this.cancel = null;
  }

  /** Forgets everything said, as on sign-out. */
  reset(): void {
    this.drop();
    this.latest = null;
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const [only] = this.queue;
    let text: string;
    if (this.queue.length === 1 && only) {
      // By code points, so a character outside the BMP is never cut in half.
      text = `${only.message.from}: ${Array.from(only.message.body).slice(0, ANNOUNCE_CHARS).join('')}`;
    } else {
      const labels = new Set(this.queue.map((pending) => pending.label));
      const where = labels.size > 1 ? `${labels.size} conversations` : (only?.label ?? CHANNEL);
      text = `${this.queue.length} new messages in ${where}`;
    }
    this.latest = { text, seq: (this.latest?.seq ?? 0) + 1 };
    this.lastAt = this.clock.now();
    this.queue = [];
  }
}
