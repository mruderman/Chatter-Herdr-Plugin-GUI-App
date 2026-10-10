// Where the reader is in the feed, and when their read pointer moves (plan T8a, "Reading position").
// The feed calls update() after every render, in a layout effect, so a placement is done before the
// browser paints and the reader never sees the unplaced frame. Every scroll here is instant: nothing
// sets a smooth behaviour, so prefers-reduced-motion has nothing to switch off.
import type { Message } from '../../../api/types';

/** markRead waits this long after the last reason to call it (plan T8a). */
export const MARK_READ_DELAY_MS = 500;

/**
 * This close to the end counts as the bottom, in CSS px. Browsers keep fractional scroll offsets at
 * non-integer zoom levels, so a log scrolled all the way down can stop a fraction of a pixel short.
 */
export const BOTTOM_SLACK_PX = 4;

/** The attribute each message element carries with its id, so a message can be found after a render. */
export const MESSAGE_ID_ATTRIBUTE = 'data-message-id';

/** Whether the end of the log's content is inside its visible area. */
export function isAtBottom(log: HTMLElement): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
}

/** How far the top of `element` sits below the top edge of the log's visible area. */
function offsetInView(log: HTMLElement, element: Element): number {
  return element.getBoundingClientRect().top - (log.getBoundingClientRect().top + log.clientTop);
}

/**
 * Where an opened conversation puts the reader: the "New messages" separator (the only separator in
 * the log), or the day heading straight above it, so the date of the first unread message shows too.
 */
function openTarget(log: HTMLElement): Element | null {
  const marker = log.querySelector('[role="separator"]');
  const above = marker?.previousElementSibling;
  return above instanceof HTMLHeadingElement ? above : marker;
}

interface Anchor {
  /** The first message the reader could see when older messages were asked for. */
  readonly id: number;
  /** Its distance below the top of the visible area at that moment. */
  readonly offset: number;
  /** The first message of the feed then; older messages have arrived once it changes. */
  readonly firstId: number | undefined;
}

export class ReadingPosition {
  private key: string | null = null;
  /** Placed at the marker or the bottom for the current conversation. */
  private positioned = false;
  /** At the bottom before the latest render, so new messages keep the reader there. */
  private pinned = true;
  private firstId: number | undefined;
  private lastId: number | undefined;
  /** The newest id markRead was last called for in this conversation, so repeats send nothing. */
  private markedId: number | undefined;
  private anchor: Anchor | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly log: () => HTMLElement | null;
  private readonly markRead: () => void;

  constructor(log: () => HTMLElement | null, markRead: () => void) {
    this.log = log;
    this.markRead = markRead;
  }

  /**
   * After every render. `key` names the conversation (repo and conversation id): when it changes the
   * conversation counts as opened, and it is placed once it has messages to show, which may be a
   * later render when they are still loading.
   */
  update(key: string, messages: readonly Message[]): void {
    const log = this.log();
    if (!log) return;
    if (key !== this.key) {
      this.key = key;
      this.positioned = false;
      this.pinned = true;
      this.firstId = undefined;
      this.lastId = undefined;
      this.markedId = undefined;
      this.anchor = null;
      this.cancel();
    }
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (!first || !last) return;
    const arrived = this.lastId !== undefined && last.id > this.lastId;
    this.firstId = first.id;
    this.lastId = last.id;

    if (!this.positioned) {
      const target = openTarget(log);
      if (target) log.scrollTop += offsetInView(log, target);
      else log.scrollTop = log.scrollHeight;
      this.positioned = true;
      this.pinned = isAtBottom(log);
      this.schedule();
    } else if (this.anchor && this.anchor.firstId !== first.id) {
      const { id, offset } = this.anchor;
      this.anchor = null;
      const element = log.querySelector(`[${MESSAGE_ID_ATTRIBUTE}="${id}"]`);
      if (element) log.scrollTop += offsetInView(log, element) - offset;
      this.pinned = isAtBottom(log);
    } else if (arrived) {
      // Only a reader who was at the bottom follows new messages; anyone else stays where they are.
      if (this.pinned) log.scrollTop = log.scrollHeight;
      this.schedule();
    }
  }

  /** The log scrolled, by the reader or by update(). */
  onScroll(): void {
    const log = this.log();
    if (!log) return;
    this.pinned = isAtBottom(log);
    // Reaching the newest message by scrolling is reading it, as much as opening the conversation there is.
    if (this.pinned) this.schedule();
  }

  /** The page was hidden or shown again (`visibilitychange`). */
  onVisibilityChange(): void {
    this.schedule();
  }

  /** Before asking for older messages: remember which message the reader is looking at, and where. */
  holdAnchor(): void {
    const log = this.log();
    this.anchor = null;
    if (!log) return;
    const top = log.getBoundingClientRect().top + log.clientTop;
    for (const element of log.querySelectorAll<HTMLElement>(`[${MESSAGE_ID_ATTRIBUTE}]`)) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > top) {
        this.anchor = { id: Number(element.getAttribute(MESSAGE_ID_ATTRIBUTE)), offset: rect.top - top, firstId: this.firstId };
        return;
      }
    }
  }

  dispose(): void {
    this.cancel();
  }

  /** Read only while the page is shown and the newest message is in view. */
  private canMarkRead(): boolean {
    const log = this.log();
    return log !== null && document.visibilityState === 'visible' && isAtBottom(log);
  }

  /** Debounced: each new reason restarts the wait, and the conditions are checked again when it ends. */
  private schedule(): void {
    if (!this.canMarkRead()) return;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.canMarkRead() || this.lastId === undefined || this.lastId === this.markedId) return;
      this.markedId = this.lastId;
      this.markRead();
    }, MARK_READ_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
