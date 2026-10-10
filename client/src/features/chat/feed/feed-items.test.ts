import { describe, expect, it } from 'vitest';
import { CHANNEL, type Message } from '../../../api/types';
import { createFeedDates, feedItems, type FeedItem, type FeedItemsInput } from './feed-items';

// Strings are written out as docs/ui-contract.md has them, not read from the module's constants, so a
// changed constant cannot quietly change the contract.

let nextId = 100;
function message(from: string, createdAt: string, extra: Partial<Message> = {}): Message {
  nextId += 1;
  return { id: nextId, from, to: CHANNEL, body: `body ${nextId}`, kind: 'post', ref_id: null, created_at: createdAt, mentions: [], everyone: false, ...extra };
}

const UTC = createFeedDates('en', 'UTC');

function items(messages: readonly Message[], overrides: Partial<FeedItemsInput> = {}): FeedItem[] {
  return feedItems({ messages, markerBeforeId: null, me: 'thom', conversationKind: 'channel', dates: UTC, ...overrides });
}

type MessageItem = Extract<FeedItem, { type: 'message' }>;
const messagesOf = (list: readonly FeedItem[]): MessageItem[] => list.filter((item): item is MessageItem => item.type === 'message');
/** Each message's id and whether it shows the sender and time header. */
const headers = (list: readonly FeedItem[]): Array<[number, boolean]> => messagesOf(list).map((item) => [item.message.id, item.startsGroup]);
const shape = (list: readonly FeedItem[]): string[] =>
  list.map((item) => (item.type === 'message' ? `message ${item.message.id}` : item.type === 'day' ? `day ${item.dayKey}` : 'marker'));

describe('grouping: consecutive messages from one sender within 5 minutes share one header', () => {
  it('keeps a message exactly 5 minutes after the one before it in the group', () => {
    const list = [message('mira', '2026-10-10T15:00:00Z'), message('mira', '2026-10-10T15:05:00Z')];
    expect(headers(items(list)).map(([, starts]) => starts)).toEqual([true, false]);
  });

  it('starts a new group one second past 5 minutes', () => {
    const list = [message('mira', '2026-10-10T15:00:00Z'), message('mira', '2026-10-10T15:05:01Z')];
    expect(headers(items(list)).map(([, starts]) => starts)).toEqual([true, true]);
  });

  it('measures from the message just before, so a steady run stays one group', () => {
    const list = [
      message('mira', '2026-10-10T15:00:00Z'),
      message('mira', '2026-10-10T15:04:00Z'),
      message('mira', '2026-10-10T15:08:00Z'),
      message('mira', '2026-10-10T15:12:00Z'),
    ];
    expect(headers(items(list)).map(([, starts]) => starts)).toEqual([true, false, false, false]);
  });

  it('starts a new group when the sender changes, even a second later', () => {
    const list = [message('mira', '2026-10-10T15:00:00Z'), message('thom', '2026-10-10T15:00:01Z'), message('mira', '2026-10-10T15:00:02Z')];
    expect(headers(items(list)).map(([, starts]) => starts)).toEqual([true, true, true]);
  });

  it('starts a new group when a later message carries an earlier time', () => {
    const list = [message('mira', '2026-10-10T15:00:00Z'), message('mira', '2026-10-10T14:59:00Z')];
    expect(headers(items(list)).map(([, starts]) => starts)).toEqual([true, true]);
  });
});

describe('day headings: one per local day, in the time zone given', () => {
  // 03:58 and 04:02 UTC on 10 October are 23:58 on 9 October and 00:02 on 10 October in New York (EDT).
  const lateEvening = message('mira', '2026-10-10T03:58:00Z');
  const pastMidnight = message('mira', '2026-10-10T04:02:00Z');

  it('in UTC: one day, and the two messages share a group', () => {
    const list = items([lateEvening, pastMidnight]);
    expect(shape(list)).toEqual(['day 2026-10-10', `message ${lateEvening.id}`, `message ${pastMidnight.id}`]);
    expect(list[0]).toMatchObject({ type: 'day', label: 'Saturday, October 10, 2026' });
    expect(headers(list).map(([, starts]) => starts)).toEqual([true, false]);
  });

  it('in New York: local midnight falls between them, so there are two days and the second message has its own header', () => {
    const list = items([lateEvening, pastMidnight], { dates: createFeedDates('en', 'America/New_York') });
    expect(shape(list)).toEqual(['day 2026-10-09', `message ${lateEvening.id}`, 'day 2026-10-10', `message ${pastMidnight.id}`]);
    expect(list.filter((item) => item.type === 'day').map((item) => item.type === 'day' && item.label)).toEqual([
      'Friday, October 9, 2026',
      'Saturday, October 10, 2026',
    ]);
    expect(headers(list).map(([, starts]) => starts)).toEqual([true, true]);
  });

  it('heads a day once however many messages it holds', () => {
    const list = items([message('a', '2026-10-10T08:00:00Z'), message('b', '2026-10-10T12:00:00Z'), message('c', '2026-10-10T23:59:59Z')]);
    expect(list.filter((item) => item.type === 'day')).toHaveLength(1);
  });

  it('writes the date in the locale given', () => {
    // The words, not the exact string: punctuation in long dates differs between ICU releases.
    const [day] = items([message('a', '2026-10-10T08:00:00Z')], { dates: createFeedDates('de', 'UTC') });
    expect(day?.type === 'day' && day.label).toMatch(/Samstag.*10.*Oktober.*2026/);
  });
});

describe('times: HH:MM, 24-hour, local', () => {
  const at = (iso: string, timeZone: string, locale = 'en'): string => createFeedDates(locale, timeZone).time(iso);

  it('converts to the time zone given', () => {
    expect(at('2026-10-10T13:05:00Z', 'UTC')).toBe('13:05');
    expect(at('2026-10-10T13:05:00Z', 'Asia/Kolkata')).toBe('18:35');
    expect(at('2026-10-10T13:05:00Z', 'America/New_York')).toBe('09:05');
  });

  it('writes midnight as 00, never 24', () => {
    expect(at('2026-10-10T00:07:00Z', 'UTC')).toBe('00:07');
  });

  it('keeps the colon and Latin digits in locales that write times otherwise', () => {
    expect(at('2026-10-10T13:05:00Z', 'UTC', 'fi')).toBe('13:05');
    expect(at('2026-10-10T13:05:00Z', 'UTC', 'ar-EG')).toBe('13:05');
  });
});

describe('the "New messages" marker', () => {
  const list = [message('flan', '2026-10-10T15:00:00Z'), message('flan', '2026-10-10T15:01:00Z'), message('flan', '2026-10-10T15:02:00Z')];
  const [first, second, third] = list as [Message, Message, Message];

  it('goes once, straight before the message it names', () => {
    const result = items(list, { markerBeforeId: second.id });
    expect(shape(result)).toEqual(['day 2026-10-10', `message ${first.id}`, 'marker', `message ${second.id}`, `message ${third.id}`]);
  });

  it('is absent when the store names none', () => {
    expect(shape(items(list)).filter((entry) => entry === 'marker')).toEqual([]);
  });

  it('is absent when the message it names is not loaded', () => {
    expect(shape(items(list, { markerBeforeId: 1 })).filter((entry) => entry === 'marker')).toEqual([]);
  });

  it('breaks the group, so the first unread message says who wrote it', () => {
    expect(headers(items(list, { markerBeforeId: second.id }))).toEqual([
      [first.id, true],
      [second.id, true],
      [third.id, false],
    ]);
  });

  it('follows the day heading when the first unread message starts a day', () => {
    expect(shape(items(list, { markerBeforeId: first.id })).slice(0, 3)).toEqual(['day 2026-10-10', 'marker', `message ${first.id}`]);
  });
});

describe('labels: Mentions you, Direct message, Admin view', () => {
  const labelsOf = (entry: Message, overrides: Partial<FeedItemsInput> = {}) => messagesOf(items([entry], overrides))[0]?.labels;

  it('"Mentions you" when the message mentions the signed-in member', () => {
    expect(labelsOf(message('mira', '2026-10-10T15:00:00Z', { mentions: ['thom'] }))).toEqual(['Mentions you']);
  });

  it('"Mentions you" for @everyone too', () => {
    expect(labelsOf(message('flan', '2026-10-10T15:00:00Z', { everyone: true }))).toEqual(['Mentions you']);
  });

  it('nothing when someone else is mentioned, or when nobody is signed in', () => {
    expect(labelsOf(message('mira', '2026-10-10T15:00:00Z', { mentions: ['codex', 'ghost'] }))).toEqual([]);
    expect(labelsOf(message('mira', '2026-10-10T15:00:00Z', { mentions: ['thom'] }), { me: null })).toEqual([]);
  });

  it('"Direct message" on every message of a direct conversation', () => {
    const direct = items([message('mira', '2026-10-10T15:00:00Z', { to: 'thom' }), message('thom', '2026-10-10T15:00:30Z', { to: 'mira' })], {
      conversationKind: 'direct',
    });
    expect(messagesOf(direct).map((item) => item.labels)).toEqual([['Direct message'], ['Direct message']]);
  });

  it('"Admin view" on every message of an observed conversation, beside "Mentions you" when the admin is mentioned', () => {
    const observed = items([message('mira', '2026-10-10T15:00:00Z', { to: 'thom' }), message('thom', '2026-10-10T15:00:30Z', { to: 'mira', mentions: ['flan'] })], {
      conversationKind: 'observed',
      me: 'flan',
    });
    expect(messagesOf(observed).map((item) => item.labels)).toEqual([['Admin view'], ['Mentions you', 'Admin view']]);
  });

  it('no DM label in #chat', () => {
    expect(labelsOf(message('mira', '2026-10-10T15:00:00Z'))).toEqual([]);
  });
});
