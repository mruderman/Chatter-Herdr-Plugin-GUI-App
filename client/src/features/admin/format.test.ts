import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../api/types';
import { ROLE_LABEL, createTimeFormatter, describeAuditEntry } from './format';

const ENTRY: AuditEntry = {
  id: 1,
  at: '2026-10-10T14:06:57.115Z',
  actor: 'flan',
  action: 'member_update',
  target: 'ezra',
  repo: 'repo-c522d9cf',
  message_id: 7,
  detail: { display_name: 'Ezra R.', can_address_agents: false, pushed: ['codex'], note: null },
};

describe('createTimeFormatter', () => {
  it('writes year, month, day and the time to the second in one fixed layout, in the zone it is given', () => {
    expect(createTimeFormatter('UTC')('2026-10-10T14:06:57.115Z')).toBe('2026-10-10 14:06:57');
    expect(createTimeFormatter('Asia/Tokyo')('2026-10-10T14:06:57.115Z')).toBe('2026-10-10 23:06:57');
    expect(createTimeFormatter('America/Los_Angeles')('2026-10-10T14:06:57.115Z')).toBe('2026-10-10 07:06:57');
  });

  it('counts midnight as 00 and the afternoon as 14, on a 24-hour clock', () => {
    const format = createTimeFormatter('UTC');
    expect(format('2026-10-11T00:00:05.000Z')).toBe('2026-10-11 00:00:05');
    expect(format('2026-10-11T23:59:59.000Z')).toBe('2026-10-11 23:59:59');
  });

  it('shows the text it was given rather than "NaN" when that is not a time', () => {
    expect(createTimeFormatter('UTC')('not a time')).toBe('not a time');
  });
});

describe('describeAuditEntry', () => {
  it('lists the target, the repository, the message and then whatever the bridge recorded, as name: value', () => {
    expect(describeAuditEntry(ENTRY)).toBe('target: ezra, repo: repo-c522d9cf, message: 7, display_name: Ezra R., can_address_agents: false, pushed: ["codex"], note: null');
  });

  it('leaves out what an entry does not have', () => {
    expect(describeAuditEntry({ ...ENTRY, target: null, repo: null, message_id: null, detail: null })).toBe('');
    expect(describeAuditEntry({ ...ENTRY, repo: null, message_id: null, detail: null })).toBe('target: ezra');
    expect(describeAuditEntry({ ...ENTRY, target: null, message_id: null, detail: null })).toBe('repo: repo-c522d9cf');
    expect(describeAuditEntry({ ...ENTRY, target: null, repo: null, detail: null })).toBe('message: 7');
  });

  it('shows a message id of 0 as it is, because 0 is an id and not a missing one', () => {
    expect(describeAuditEntry({ ...ENTRY, target: null, repo: null, detail: null, message_id: 0 })).toBe('message: 0');
  });
});

describe('ROLE_LABEL', () => {
  it('says Admin and Member, which are the words of the Role selects', () => {
    expect(ROLE_LABEL).toEqual({ admin: 'Admin', member: 'Member' });
  });
});
