// Every string the Members view shows. The heading and the two list names are fixed by
// docs/ui-contract.md section 4; the rest is worded here once.

export const MEMBERS_TEXT = {
  title: 'Members',
  /** The accessible name of the list of members. The page's own h1 is the visible heading for it. */
  membersList: 'Members',
  agentsHeading: 'Agents',
  agentsList: 'Agents',
  loading: 'Loading the member list',
  noMembers: 'There are no members to show.',
  noAgents: 'No agents are known yet.',
  // Says what agents are without claiming more than the SPEC does (section 6: addressing an agent
  // needs the member's `can_address_agents`).
  agentsHint: 'Agents run in Herdr. Members who are allowed to address agents can mention or message them by name.',
} as const;

/** The handle after the display name, as the header writes a member: "{display_name} ({handle})". */
export const handleLabel = (handle: string): string => `(${handle})`;
