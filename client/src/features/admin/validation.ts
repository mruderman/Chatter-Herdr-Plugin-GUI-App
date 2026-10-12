// What the member forms check before anything is sent. The bridge checks the same rules again and
// stays the authority (SPEC section 6); these exist so a typo is caught next to the field, in words,
// instead of coming back as a refusal. The Tailscale login is not checked: the bridge cannot know what
// Tailscale will call a person either, and a wrong one simply never matches.
import type { AddMemberRequest, Member, MemberKind, MemberRole, UpdateMemberRequest } from '../../api/types';

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** The word the bridge keeps for "every member" (D8); it can never be a handle. */
export const RESERVED_HANDLE = 'everyone';

export const HANDLE_RULE =
  'Use 1 to 32 characters: lowercase letters, digits, hyphens and underscores, starting with a letter or digit.';

export function validateHandle(value: string): string | null {
  const handle = value.trim();
  if (handle === '') return 'Enter a handle.';
  if (handle === RESERVED_HANDLE) return '"everyone" is reserved for messages to all members. Choose another handle.';
  if (!HANDLE_PATTERN.test(handle)) return HANDLE_RULE;
  return null;
}

export function validateDisplayName(value: string): string | null {
  return value.trim() === '' ? 'Enter a display name.' : null;
}

/** What the person typed or chose, before trimming. */
export interface MemberFormValues {
  handle: string;
  displayName: string;
  kind: MemberKind;
  role: MemberRole;
  canAddressAgents: boolean;
  tailscaleLogin: string;
}

// An empty login field means "no login". The bridge stores whatever it is sent, so an empty string
// would be kept as a login of its own (observed: the second member with one is refused with a 500).
function loginOrNull(value: string): string | null {
  const login = value.trim();
  return login === '' ? null : login;
}

/** Humans never get a token from this request (`issue_token` stays out): a computational member always does. */
export function addMemberRequest(values: MemberFormValues): AddMemberRequest {
  return {
    handle: values.handle.trim(),
    kind: values.kind,
    display_name: values.displayName.trim(),
    role: values.role,
    can_address_agents: values.canAddressAgents,
    tailscale_login: loginOrNull(values.tailscaleLogin),
  };
}

/**
 * Only the fields that differ from `member`. The bridge writes the audit entry from what it was sent,
 * so sending everything would log changes that did not happen, and an empty patch is logged too
 * (observed), so the caller refuses to send one.
 */
export function memberPatch(member: Member, values: MemberFormValues): UpdateMemberRequest {
  const patch: {
    -readonly [K in keyof UpdateMemberRequest]: UpdateMemberRequest[K];
  } = {};
  const displayName = values.displayName.trim();
  if (displayName !== member.display_name) patch.display_name = displayName;
  if (values.kind !== member.kind) patch.kind = values.kind;
  if (values.role !== member.role) patch.role = values.role;
  if (values.canAddressAgents !== member.can_address_agents) patch.can_address_agents = values.canAddressAgents;
  const login = loginOrNull(values.tailscaleLogin);
  if (login !== member.tailscale_login) patch.tailscale_login = login;
  return patch;
}

export function isEmptyPatch(patch: UpdateMemberRequest): boolean {
  return Object.keys(patch).length === 0;
}
