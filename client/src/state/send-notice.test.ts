// What the bridge's answer to an accepted send tells the sender (SPEC section 5: `warnings`, `delivery`,
// and the " (queued)" suffix of `pushed`), worded once for the fake store and the real one.
import { describe, expect, it } from 'vitest';
import { CHANNEL, type SendResult } from '../api/types';
import { announcementOf, makeNotice, noticeLines, NOTICE_LEAD, queuedText } from './send-notice';

// Chatter 0.19.0 writes the dash as U+2014; the bridge passes the line through whole (bridge/src/server.js KNOWN_WARNINGS).
const NO_AGENT = (name: string): string => `mention @${name} matches no agent in this repo — not pushed`;

const answer = (overrides: Partial<SendResult> = {}): SendResult => ({
  id: 7,
  pushed: [],
  warnings: [],
  mentioned_members: [],
  delivery: null,
  ...overrides,
});

describe('noticeLines: what is told about a send that the bridge accepted', () => {
  it('says nothing about an ordinary send', () => {
    expect(noticeLines({ to: CHANNEL, body: 'hello' }, answer())).toEqual([]);
    expect(makeNotice({ to: CHANNEL, body: 'hello' }, answer(), 1)).toBeNull();
  });

  it('says nothing extra when an agent was addressed and the message was delivered, or a pane took a mention', () => {
    expect(noticeLines({ to: 'codex', body: 'hi' }, answer({ delivery: 'delivered' }))).toEqual([]);
    expect(noticeLines({ to: CHANNEL, body: 'hi @codex' }, answer({ pushed: ['codex'] }))).toEqual([]);
  });

  it('shows each warning as the bridge gave it, in order', () => {
    const warnings = [NO_AGENT('nobodyhere'), NO_AGENT('ghost')];
    expect(noticeLines({ to: CHANNEL, body: '@nobodyhere @ghost' }, answer({ warnings }))).toEqual(warnings);
  });

  it('shows a warning that Chatter repeated for a repeated mention once', () => {
    const warnings = [NO_AGENT('zzz'), NO_AGENT('zzz')];
    expect(noticeLines({ to: CHANNEL, body: '@zzz @zzz' }, answer({ warnings }))).toEqual([NO_AGENT('zzz')]);
  });

  it('says that a DM to an agent was stored but not delivered when the bridge says it was queued', () => {
    expect(noticeLines({ to: 'codex', body: 'hi' }, answer({ delivery: 'queued' }))).toEqual([queuedText('codex')]);
  });

  it('says it for each agent that a post mentioned and could only be queued for, and not for the others', () => {
    const pushed = ['codex (queued)', 'ivy-one', 'rowan-worker (queued)'];
    expect(noticeLines({ to: CHANNEL, body: '@codex @ivy-one @rowan-worker' }, answer({ pushed }))).toEqual([queuedText('codex'), queuedText('rowan-worker')]);
  });

  it('puts the warnings first and the queued agents after them', () => {
    const lines = noticeLines({ to: CHANNEL, body: '@codex @zzz' }, answer({ warnings: [NO_AGENT('zzz')], pushed: ['codex (queued)'] }));
    expect(lines).toEqual([NO_AGENT('zzz'), queuedText('codex')]);
  });

  it('does not say a message was queued for a member, whatever the bridge sent as delivery', () => {
    // `delivery` is null for a DM to a member; the sender is the one who knows who the recipient is.
    expect(noticeLines({ to: 'mira', body: 'hi' }, answer({ delivery: null }))).toEqual([]);
  });

  it('claims no more than the bridge knows about why the message was queued, and promises no later delivery', () => {
    const text = queuedText('codex');
    expect(text).toContain('saved');
    expect(text).toContain('@codex');
    expect(text).not.toMatch(/will be delivered|will deliver|soon|later|retry/i);
    expect(text).not.toMatch(/pane|herdr|chatter/i);
  });
});

describe('makeNotice and announcementOf', () => {
  it('carries the lead sentence, the lines and the sequence number', () => {
    const notice = makeNotice({ to: CHANNEL, body: '@zzz' }, answer({ warnings: [NO_AGENT('zzz')] }), 3);
    expect(notice).toEqual({ lead: NOTICE_LEAD, lines: [NO_AGENT('zzz')], seq: 3 });
    expect(Object.isFrozen(notice)).toBe(true);
    expect(Object.isFrozen(notice?.lines)).toBe(true);
  });

  it('opens with words that say the message went, so colour is not what tells it from "Not sent: "', () => {
    expect(NOTICE_LEAD).toMatch(/sent/i);
    expect(NOTICE_LEAD).not.toMatch(/^Not sent/);
  });

  it('is announced as the lead and every line, in one text', () => {
    const notice = makeNotice({ to: 'codex', body: 'hi' }, answer({ delivery: 'queued', warnings: [NO_AGENT('zzz')] }), 1);
    expect(notice && announcementOf(notice)).toBe(`${NOTICE_LEAD} ${NO_AGENT('zzz')} ${queuedText('codex')}`);
  });

  it('keeps markup in a warning as the text it is: a string, never parsed here', () => {
    const hostile = '<img src=x onerror="window.pwned = 1">';
    const notice = makeNotice({ to: CHANNEL, body: 'x' }, answer({ warnings: [hostile] }), 1);
    expect(notice?.lines).toEqual([hostile]);
  });
});
