import { describe, expect, it } from 'vitest';
import type { Member } from '../../api/types';
import {
  HANDLE_RULE,
  addMemberRequest,
  isEmptyPatch,
  memberPatch,
  validateDisplayName,
  validateHandle,
  type MemberFormValues,
} from './validation';

const MEMBER: Member = {
  handle: 'ezra',
  display_name: 'Ezra',
  kind: 'human',
  role: 'member',
  can_address_agents: true,
  tailscale_login: null,
  status: 'active',
  created_at: '2026-10-10T14:06:55.692Z',
  last_seen_at: null,
};

const VALUES: MemberFormValues = {
  handle: 'ezra',
  displayName: 'Ezra',
  kind: 'human',
  role: 'member',
  canAddressAgents: true,
  tailscaleLogin: '',
};

describe('validateHandle (SPEC section 6)', () => {
  it.each(['a', '7', 'alice', 'a1_b-c', 'x'.repeat(32), 'grace-2', '0day'])('accepts "%s"', (handle) => {
    expect(validateHandle(handle)).toBeNull();
  });

  it('judges the trimmed text, because whitespace around a pasted handle is never part of it', () => {
    expect(validateHandle('  alice  ')).toBeNull();
  });

  it('asks for a handle when there is none', () => {
    expect(validateHandle('')).toBe('Enter a handle.');
    expect(validateHandle('   ')).toBe('Enter a handle.');
  });

  it.each(['Alice', 'bad handle', '-lead', '_lead', 'x'.repeat(33), 'ünï', 'a.b', 'a/b', 'a@b', '__proto__', 'al\nice'])(
    'states the rule for "%s"',
    (handle) => {
      expect(validateHandle(handle)).toBe(HANDLE_RULE);
    },
  );

  it('refuses "everyone" with its own reason, bare or padded, because the bridge reserves it (D8)', () => {
    for (const handle of ['everyone', ' everyone ']) {
      const message = validateHandle(handle);
      expect(message).toMatch(/everyone/);
      expect(message).not.toBe(HANDLE_RULE);
    }
  });

  it('does not treat other words that contain "everyone" as reserved', () => {
    expect(validateHandle('everyone2')).toBeNull();
    expect(validateHandle('not-everyone')).toBeNull();
  });
});

describe('validateDisplayName', () => {
  it('needs something other than whitespace', () => {
    expect(validateDisplayName('')).toBe('Enter a display name.');
    expect(validateDisplayName(' \t ')).toBe('Enter a display name.');
    expect(validateDisplayName('Ezra')).toBeNull();
  });
});

describe('addMemberRequest', () => {
  it('trims, maps the form onto the request fields and leaves out issue_token', () => {
    const request = addMemberRequest({
      handle: ' kestrel ',
      displayName: '  Kestrel  ',
      kind: 'computational',
      role: 'admin',
      canAddressAgents: false,
      tailscaleLogin: '  kes@example.com ',
    });
    expect(request).toEqual({
      handle: 'kestrel',
      kind: 'computational',
      display_name: 'Kestrel',
      role: 'admin',
      can_address_agents: false,
      tailscale_login: 'kes@example.com',
    });
    expect('issue_token' in request).toBe(false);
  });

  it('sends an empty login as null, never as an empty string', () => {
    expect(addMemberRequest({ ...VALUES, tailscaleLogin: '   ' }).tailscale_login).toBeNull();
  });
});

describe('memberPatch', () => {
  it('is empty when nothing differs, and only trimming differences do not count', () => {
    expect(memberPatch(MEMBER, VALUES)).toEqual({});
    expect(isEmptyPatch(memberPatch(MEMBER, { ...VALUES, displayName: '  Ezra ' }))).toBe(true);
  });

  it('holds exactly the fields that changed', () => {
    expect(memberPatch(MEMBER, { ...VALUES, displayName: 'Ezra R.' })).toEqual({ display_name: 'Ezra R.' });
    expect(memberPatch(MEMBER, { ...VALUES, kind: 'computational', role: 'admin' })).toEqual({ kind: 'computational', role: 'admin' });
    expect(memberPatch(MEMBER, { ...VALUES, canAddressAgents: false })).toEqual({ can_address_agents: false });
    expect(memberPatch(MEMBER, { ...VALUES, tailscaleLogin: ' ezra@example.com ' })).toEqual({ tailscale_login: 'ezra@example.com' });
  });

  it('clears a login with null, and does not report an empty field over a missing login as a change', () => {
    const mapped: Member = { ...MEMBER, tailscale_login: 'ezra@example.com' };
    expect(memberPatch(mapped, { ...VALUES, tailscaleLogin: '' })).toEqual({ tailscale_login: null });
    expect(memberPatch(MEMBER, { ...VALUES, tailscaleLogin: '  ' })).toEqual({});
  });

  it('never carries the handle, which cannot be changed', () => {
    expect('handle' in memberPatch(MEMBER, { ...VALUES, handle: 'someone-else', displayName: 'X' })).toBe(false);
  });
});
