// What the feed shows, in order: a heading for each local day, the "New messages" separator once,
// and each message with its time, its labels and whether it starts a group. Kept pure so grouping,
// day boundaries and labels are tested without a DOM.
import type { Message } from '../../../api/types';
import type { Conversation } from '../../../state/types';

/** ui-contract section 3: consecutive messages from one sender within 5 minutes share one header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** The text labels of ui-contract section 3. The words are the signal; any tint only repeats them. */
export const MESSAGE_LABEL = {
  mentionsYou: 'Mentions you',
  direct: 'Direct message',
  adminView: 'Admin view',
} as const;
export type MessageLabel = (typeof MESSAGE_LABEL)[keyof typeof MESSAGE_LABEL];

/**
 * English unless a caller passes a locale: the page is `lang="en"`, so a screen reader pronounces a
 * weekday or month name in the language it reads everything else in.
 */
export const DEFAULT_LOCALE = 'en';

export interface FeedDates {
  /** "HH:MM", 24-hour, with Latin digits in every locale, as ui-contract section 8 writes it. */
  time(iso: string): string;
  /** The local calendar day as "YYYY-MM-DD": what day headings group by, and their `datetime`. */
  dayKey(iso: string): string;
  /** The local date written out, for the day heading. */
  dayLabel(iso: string): string;
}

function part(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? '';
}

/** `timeZone` undefined means the runtime's own zone: the reader's local time. */
export function createFeedDates(locale: string = DEFAULT_LOCALE, timeZone?: string): FeedDates {
  // The machine-shaped values come from a fixed locale and digit set, so "HH:MM" and the day key never
  // change shape with the reader's language (some locales write 14.05, or use other digits).
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    numberingSystem: 'latn',
  });
  const calendar = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    numberingSystem: 'latn',
  });
  const heading = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'full' });
  return {
    time(iso) {
      const parts = clock.formatToParts(new Date(iso));
      return `${part(parts, 'hour')}:${part(parts, 'minute')}`;
    },
    dayKey(iso) {
      const parts = calendar.formatToParts(new Date(iso));
      return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
    },
    dayLabel(iso) {
      return heading.format(new Date(iso));
    },
  };
}

export type FeedItem =
  | { readonly type: 'day'; readonly key: string; readonly dayKey: string; readonly label: string }
  | { readonly type: 'marker'; readonly key: string }
  | {
      readonly type: 'message';
      readonly key: string;
      readonly message: Message;
      /** "HH:MM" local. */
      readonly time: string;
      /** Shows the visible sender and time header; false continues the group above it. */
      readonly startsGroup: boolean;
      readonly labels: readonly MessageLabel[];
    };

export interface FeedItemsInput {
  readonly messages: readonly Message[];
  /** snapshot.newMarkerBeforeId */
  readonly markerBeforeId: number | null;
  /** The signed-in member's handle; null when nobody is signed in. */
  readonly me: string | null;
  /** The kind of the selected conversation, which decides the DM labels; null when none is selected. */
  readonly conversationKind: Conversation['kind'] | null;
  readonly dates: FeedDates;
}

/**
 * Whether `message` continues the group of `previous`: the same sender, at most five minutes after the
 * message just before it. A gap that runs backwards (clock skew between writers) starts a new group,
 * so a header never shows a time later than a message under it.
 */
function continuesGroup(previous: Message, message: Message): boolean {
  if (previous.from !== message.from) return false;
  const gap = Date.parse(message.created_at) - Date.parse(previous.created_at);
  return gap >= 0 && gap <= GROUP_WINDOW_MS;
}

function labelsFor(message: Message, me: string | null, kind: Conversation['kind'] | null): MessageLabel[] {
  const labels: MessageLabel[] = [];
  // Handles are lowercase (bridge/src/util.js HANDLE_RE) and the bridge lowercases every mention, so
  // plain equality is exact. `everyone` reaches every member, the signed-in one included.
  if (me !== null && (message.everyone || message.mentions.includes(me))) labels.push(MESSAGE_LABEL.mentionsYou);
  if (kind === 'direct') labels.push(MESSAGE_LABEL.direct);
  if (kind === 'observed') labels.push(MESSAGE_LABEL.adminView);
  return labels;
}

export function feedItems({ messages, markerBeforeId, me, conversationKind, dates }: FeedItemsInput): FeedItem[] {
  const items: FeedItem[] = [];
  let previous: Message | undefined;
  let previousDay: string | undefined;
  let markerPlaced = false;
  for (const message of messages) {
    const dayKey = dates.dayKey(message.created_at);
    const newDay = dayKey !== previousDay;
    if (newDay) items.push({ type: 'day', key: `day:${dayKey}`, dayKey, label: dates.dayLabel(message.created_at) });
    const marker = !markerPlaced && message.id === markerBeforeId;
    if (marker) {
      items.push({ type: 'marker', key: 'new-messages' });
      markerPlaced = true;
    }
    // A day heading or the marker between two messages breaks their group, so the first message
    // under either one always says who wrote it and when.
    const startsGroup = previous === undefined || newDay || marker || !continuesGroup(previous, message);
    items.push({
      type: 'message',
      key: `message:${message.id}`,
      message,
      time: dates.time(message.created_at),
      startsGroup,
      labels: labelsFor(message, me, conversationKind),
    });
    previous = message;
    previousDay = dayKey;
  }
  return items;
}
