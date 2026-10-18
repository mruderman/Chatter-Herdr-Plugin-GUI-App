// The Chat view's message feed (ui-contract sections 3 and 8): the "Messages" log, oldest first, with
// day headings, the "New messages" separator, and one article per message. Bodies are plain text: each
// is one text node, so nothing in a message can become markup, a link or an image.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Conversation, Store, StoreSnapshot } from '../../../state/types';
import { SKIP_TARGET } from '../../shell';
import { MESSAGE_LABEL, createFeedDates, feedItems, type FeedItem, type MessageLabel } from './feed-items';
import { MESSAGE_ID_ATTRIBUTE, ReadingPosition } from './reading-position';
import './feed.css';

export const FEED_TEXT = {
  /** The log's accessible name. */
  name: 'Messages',
  loadOlder: 'Load older messages',
  newMessages: 'New messages',
  noConversation: 'No conversation is open.',
  loading: 'Loading messages.',
  empty: 'No messages in this conversation yet.',
  /** Empty, but the bridge has older pages: they may hold some. */
  emptyRecent: 'No recent messages in this conversation.',
  /**
   * A DM the bridge lists (or one the cache let go) with none of its messages loaded, and older pages left. Said
   * instead of `emptyRecent`, which does not tell the reader what to do: the pair is there, its messages are older
   * than the newest page, and the "Load older messages" button above the log brings them in (V5 finding 9).
   */
  olderUnloaded: 'Its messages are older than the ones loaded. Press Load older messages to bring them in.',
  /**
   * For a screen reader only, in the status line beside the button, while a press in a DM keeps looking for a message
   * of it, which may be several requests (V5 finding 5). Sighted readers have the button's busy look (dashed, muted),
   * which is the busy treatment it always had: words beside it would wrap under it on a narrow screen and move the log.
   * The button's own name stays "Load older messages".
   */
  loadingOlder: 'Loading older messages...',
  /**
   * Beside the button when a press gave up at its bound (10 pages or 1,000 messages) and found none of the open DM:
   * `count` is what that press loaded, whichever conversation the messages belong to. The button stays for the next try.
   */
  lookedBack: (count: number): string =>
    `Looked back ${count} messages and found none of this conversation. Press Load older messages to look further.`,
} as const;

// The labels' tones only repeat what their words say.
const LABEL_TONE: Readonly<Record<MessageLabel, string>> = {
  [MESSAGE_LABEL.mentionsYou]: 'tone-warning',
  [MESSAGE_LABEL.direct]: 'tone-info',
  [MESSAGE_LABEL.adminView]: 'tone-neutral',
};

export interface FeedProps {
  readonly snapshot: StoreSnapshot;
  readonly store: Store;
  /** For dates in the day headings; times are always HH:MM. Defaults to English, the page's language. */
  readonly locale?: string;
  /** Defaults to the reader's own time zone. */
  readonly timeZone?: string;
}

function emptyText(snapshot: StoreSnapshot, kind: Conversation['kind'] | null): string | null {
  if (snapshot.selectedConversation === null) return FEED_TEXT.noConversation;
  if (snapshot.messages.length > 0) return null;
  if (snapshot.connection === 'syncing') return FEED_TEXT.loading;
  if (!snapshot.hasMore) return FEED_TEXT.empty;
  // #chat keeps its words: only a DM can be listed without a message of it loaded.
  return kind === 'direct' || kind === 'observed' ? FEED_TEXT.olderUnloaded : FEED_TEXT.emptyRecent;
}

function MessageEntry({ item }: { item: Extract<FeedItem, { type: 'message' }> }) {
  const { message, time, startsGroup, labels } = item;
  const classes = ['message'];
  if (startsGroup) classes.push('message--starts-group');
  if (labels.includes(MESSAGE_LABEL.mentionsYou)) classes.push('message--mentions-you');
  const attributes = { [MESSAGE_ID_ATTRIBUTE]: String(message.id) };
  return (
    <article class={classes.join(' ')} aria-label={`${message.from} at ${time}`} {...attributes}>
      {startsGroup ? (
        <div class="message__header">
          <span class="message__sender">{message.from}</span>
          <time class="message__time" dateTime={message.created_at}>
            {time}
          </time>
        </div>
      ) : (
        // The group's header already shows the time; the article's name and this element still carry it.
        <time class="visually-hidden" dateTime={message.created_at}>
          {time}
        </time>
      )}
      {/* dir="auto": a body in Hebrew or Arabic reads right to left, by its first strong letter. On the body alone, so the header keeps the page's direction. */}
      <p class="message__body" dir="auto">
        {message.body}
      </p>
      {labels.length > 0 && (
        <div class="message__labels">
          {labels.map((label) => (
            <span key={label} class={`badge ${LABEL_TONE[label]}`}>
              {label}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function Entry({ item }: { item: FeedItem }) {
  if (item.type === 'day') {
    return (
      <h3 class="feed__day">
        <time dateTime={item.dayKey}>{item.label}</time>
      </h3>
    );
  }
  if (item.type === 'marker') {
    // A separator's content is presentational, so the name comes from aria-label; the words repeat it on screen.
    return (
      <div class="feed__marker" role="separator" aria-label={FEED_TEXT.newMessages}>
        {FEED_TEXT.newMessages}
      </div>
    );
  }
  return <MessageEntry item={item} />;
}

interface OlderButtonProps {
  readonly busy: boolean;
  readonly onLoad: () => void;
  /** Called when the button is about to leave the page while it has focus. */
  readonly onLeaveWithFocus: () => void;
}

function OlderButton({ busy, onLoad, onLeaveWithFocus }: OlderButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const leave = useRef(onLeaveWithFocus);
  leave.current = onLeaveWithFocus;
  // Preact runs this cleanup before it removes the button, so focus can move on while the button still
  // holds it. Otherwise loading the last older page would drop a keyboard reader's focus to <body>.
  useLayoutEffect(
    () => () => {
      if (ref.current !== null && document.activeElement === ref.current) leave.current();
    },
    [],
  );
  return (
    // aria-disabled rather than disabled while a page loads, so the button keeps focus; aria-busy says that the press is working.
    <button
      ref={ref}
      type="button"
      class="feed__older"
      aria-disabled={busy ? 'true' : undefined}
      aria-busy={busy ? 'true' : undefined}
      onClick={onLoad}
    >
      {FEED_TEXT.loadOlder}
    </button>
  );
}

export function Feed({ snapshot, store, locale, timeZone }: FeedProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const reading = useMemo(
    () =>
      new ReadingPosition(
        () => logRef.current,
        () => {
          // A failed acknowledgement is the store's to retry (state/store.ts); the feed has nothing to add.
          storeRef.current.markRead().catch(() => undefined);
        },
      ),
    [],
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  // A ref as well as state: two presses before the next render must still send one request.
  const olderInFlight = useRef(false);
  // What the last press that gave up at its bound looked through, and in which conversation (V5 finding 5).
  const [lookedBack, setLookedBack] = useState<{ readonly key: string; readonly count: number } | null>(null);

  const dates = useMemo(() => createFeedDates(locale, timeZone), [locale, timeZone]);
  const conversation = snapshot.conversations.find((candidate) => candidate.id === snapshot.selectedConversation);
  const kind = conversation?.kind ?? null;
  const me = snapshot.session.status === 'signed-in' ? snapshot.session.me.handle : null;
  const items = useMemo(
    () => feedItems({ messages: snapshot.messages, markerBeforeId: snapshot.newMarkerBeforeId, me, conversationKind: kind, dates }),
    [snapshot.messages, snapshot.newMarkerBeforeId, me, kind, dates],
  );
  const key = `${snapshot.selectedRepo ?? ''}\n${snapshot.selectedConversation ?? ''}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  // What a press found out is about the conversation it was made in: opening another takes it away for good.
  useEffect(() => {
    setLookedBack(null);
  }, [key]);

  useLayoutEffect(() => {
    reading.update(key, snapshot.messages, me);
  }, [reading, key, snapshot.messages, me]);

  useEffect(() => {
    const onVisibilityChange = () => reading.onVisibilityChange();
    // The log sits in a page that scrolls, so the reader can bring its end into view by scrolling the page
    // or by resizing the window, with no event on the log itself. Passive: this only reads the layout.
    const onWindowMove = () => reading.onScroll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('scroll', onWindowMove, { passive: true });
    window.addEventListener('resize', onWindowMove, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('scroll', onWindowMove);
      window.removeEventListener('resize', onWindowMove);
      reading.dispose();
    };
  }, [reading]);

  function loadOlder(): void {
    if (olderInFlight.current) return;
    olderInFlight.current = true;
    setLoadingOlder(true);
    setLookedBack(null);
    reading.holdAnchor();
    const pressedIn = key;
    storeRef.current
      .loadOlder()
      .then((result) => {
        // Said only where it was asked: the reader may have opened another conversation while the pages came.
        if (result.lookedBack !== null && keyRef.current === pressedIn) setLookedBack({ key: pressedIn, count: result.lookedBack });
      })
      .catch(() => undefined)
      .finally(() => {
        olderInFlight.current = false;
        setLoadingOlder(false);
      });
  }

  const status = emptyText(snapshot, kind);
  // A press in a DM may take several requests, so a screen reader is told; #chat's is one page and over before it could be read.
  const looksFurther = loadingOlder && (kind === 'direct' || kind === 'observed');
  const lookedBackText = lookedBack !== null && lookedBack.key === key ? FEED_TEXT.lookedBack(lookedBack.count) : '';
  return (
    <div class="feed">
      {snapshot.hasMore && snapshot.selectedConversation !== null && (
        // The line sits beside the button and outside the log: a line appearing above the messages would move them,
        // and the reading position (reading-position.ts) only puts the reader back when the first message changes.
        // The status element is always there while the button is, so that a screen reader has the region before its text.
        <div class="feed__older-bar">
          <OlderButton busy={loadingOlder} onLoad={loadOlder} onLeaveWithFocus={() => logRef.current?.focus({ preventScroll: true })} />
          <p class="feed__status feed__older-status" role="status">
            {looksFurther ? <span class="visually-hidden">{FEED_TEXT.loadingOlder}</span> : lookedBackText}
          </p>
        </div>
      )}
      <div
        ref={logRef}
        id={SKIP_TARGET.messages}
        class="feed__log"
        role="log"
        aria-label={FEED_TEXT.name}
        // Arrivals are announced by the throttled Announcements region instead, so a busy chat does not flood a screen reader.
        aria-live="off"
        tabIndex={0}
        onScroll={() => reading.onScroll()}
      >
        {status !== null && <p class="feed__status">{status}</p>}
        {items.map((item) => (
          <Entry key={item.key} item={item} />
        ))}
      </div>
    </div>
  );
}
