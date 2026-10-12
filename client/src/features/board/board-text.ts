// Every string the Board view shows, in one place. The headings, the button and the table captions
// are fixed by docs/ui-contract.md section 4 (tests and E2E specs select on them); the rest is
// worded here once so a change cannot leave two spellings behind. Prefixes end in a space on purpose:
// the message that follows comes from the bridge and is appended as it is.

export const BOARD_TEXT = {
  title: 'Board',
  refreshButton: 'Refresh board',
  /** Announced (politely, off screen) after someone pressed Refresh and the board came back. */
  refreshed: 'Board refreshed',
  loading: 'Loading the board',
  noRepository: 'No repository is selected, so there is no board to show.',
  loadFailed: 'Could not load the board: ',
  refreshFailed: 'Could not refresh the board: ',
  showingLoadedAt: 'Showing the board as it was loaded at ',
  updated: 'Updated ',
  agentsUnavailable: 'Agents are unavailable: ',
  /** For a failure that carries no message of its own. */
  unexpectedFailure: 'unexpected error',
} as const;

export const SECTION_TITLE = {
  agents: 'Agents',
  tasks: 'Tasks',
  questions: 'Open questions',
  notes: 'Notes',
  handoffs: 'Handoffs',
} as const;

export const EMPTY_TEXT = {
  agents: 'No agents are registered yet.',
  tasks: 'There are no tasks yet.',
  questions: 'There are no open questions.',
  notes: 'There are no notes yet.',
  handoffs: 'There are no handoffs yet.',
} as const;

// "Harness" is the program an agent runs in (Chatter's `kind`: codex, claude, ...). It is not called
// "Kind" here because the rest of the UI uses that word for a member being human or computational.
export const AGENT_COLUMNS = ['Name', 'Role', 'Harness', 'Status', 'Branch', 'Task', 'Last seen'] as const;
export const TASK_COLUMNS = ['ID', 'Title', 'Status', 'Assignee', 'Created by', 'Updated'] as const;

/** Stand-ins for a value the bridge sent as null, so a cell is never blank (screen readers say "blank"). */
export const PLACEHOLDER = {
  none: 'none',
  neverSeen: 'never',
  unassigned: 'unassigned',
  unknownStatus: 'unknown',
} as const;

/** Small words that join the pieces of a list item's header line. */
export const ITEM_WORD = {
  task: 'task ',
  branch: 'branch ',
  by: ' by ',
  to: ' to ',
  askedBy: 'asked by ',
  departed: 'Departed ',
} as const;

/** What goes between pieces. A comma between the parts of a header line reads as a pause. */
export const JOIN = {
  headPieces: ', ',
  taskIdAndTitle: ': ',
} as const;
