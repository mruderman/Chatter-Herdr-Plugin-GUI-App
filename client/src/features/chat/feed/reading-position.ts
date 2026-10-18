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

/**
 * Whether the log's bottom edge is inside the browser window. The log is a box in a page that scrolls, so
 * a log scrolled to its own end can still be entirely above (or below) the window, and the newest message
 * is on screen only when this holds as well as isAtBottom. The bottom edge is the one that matters: a log
 * taller than what is left of the window shows its newest message at its bottom, whatever its top does.
 */
export function isBottomInWindow(log: HTMLElement): boolean {
  const { bottom } = log.getBoundingClientRect();
  return bottom > 0 && bottom <= window.innerHeight;
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

/**
 * Whether one of the messages newer than `after` is the member's own. The whole handle is compared: another
 * member's name may start like it. `messages` holds this conversation only, so a message the member sent
 * to another conversation is not in it and moves nobody.
 */
function sentSince(messages: readonly Message[], after: number | undefined, me: string | null): boolean {
  if (me === null || after === undefined) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.id <= after) return false;
    if (message.from === me) return true;
  }
  return false;
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
  /**
   * The newest id markRead was last called for in this conversation, so repeats send nothing. It is set
   * before the call and kept when the call fails: a failed acknowledgement is the store's to retry
   * (state/store.ts), so the feed never has to send the same id again.
   */
  private markedId: number | undefined;
  private anchor: Anchor | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Hears when the log's box changes size; started by the first update() and stopped by dispose(). */
  private observer: ResizeObserver | undefined;
  private observed: HTMLElement | null = null;
  /** The height of the log's visible area when the observer last looked: what a resize is compared with. */
  private height: number | undefined;
  private readonly log: () => HTMLElement | null;
  private readonly markRead: () => void;

  constructor(log: () => HTMLElement | null, markRead: () => void) {
    this.log = log;
    this.markRead = markRead;
  }

  /**
   * After every render. `key` names the conversation (repo and conversation id): when it changes the
   * conversation counts as opened, and it is placed once it has messages to show, which may be a
   * later render when they are still loading. `me` is the member's handle: their own message arriving
   * in this conversation takes the reader to the bottom (see below).
   */
  update(key: string, messages: readonly Message[], me: string | null = null): void {
    const log = this.log();
    if (!log) return;
    this.watch(log);
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
    const before = this.lastId;
    const arrived = before !== undefined && last.id > before;
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
      // Only a reader who was at the bottom follows new messages; anyone else stays where they are. The one
      // exception is the member's own message (V5 finding 6): it answers a send, and out of view it leaves
      // them no sign that it went. They are then at the bottom, as if they had been there all along.
      if (sentSince(messages, before, me)) this.pinned = true;
      if (this.pinned) log.scrollTop = log.scrollHeight;
      this.schedule();
    }
  }

  /**
   * The log scrolled, by the reader or by update(), or the window did (the page scrolled, the window was
   * resized): either one can bring the newest message into view without a new message arriving.
   */
  onScroll(): void {
    const log = this.log();
    if (!log) return;
    this.pinned = isAtBottom(log);
    // Reaching the newest message by scrolling is reading it, as much as opening the conversation there is.
    if (this.pinned) this.schedule();
  }

  /**
   * The log's box changed size, because the box under it grew or the window did. The browser fires no
   * `scroll` for that, and scrollTop keeps its value while the visible area gets shorter, which would cut
   * the newest message off a reader who was looking at it. Whether they were is decided from the height
   * the log had, not from `pinned`: a window that got shorter has already fired `resize`, whose handler
   * (onScroll) read the shortened log and let go of the reader.
   */
  onResize(): void {
    const log = this.log();
    if (!log) return;
    const before = this.height;
    this.height = log.clientHeight;
    if (!this.positioned) return;
    if (before !== undefined && before !== this.height && log.scrollHeight - log.scrollTop - before <= BOTTOM_SLACK_PX) {
      log.scrollTop = log.scrollHeight;
    }
    // The newest message may have come into view, or the reader's place may have changed, as with a scroll.
    this.onScroll();
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
    this.observer?.disconnect();
    this.observer = undefined;
    this.observed = null;
    this.height = undefined;
  }

  /** Observes the log once, whichever render finds it first. jsdom has no ResizeObserver, and nothing resizes there. */
  private watch(log: HTMLElement): void {
    if (this.observed === log || typeof ResizeObserver === 'undefined') return;
    this.observer?.disconnect();
    this.height = log.clientHeight;
    this.observer = new ResizeObserver(() => this.onResize());
    this.observer.observe(log);
    this.observed = log;
  }

  /** Read only while the page is shown and the newest message is in view, in the log and in the window. */
  private canMarkRead(): boolean {
    const log = this.log();
    return log !== null && document.visibilityState === 'visible' && isAtBottom(log) && isBottomInWindow(log);
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
