// What the Board view shows (docs/ui-contract.md section 4): sections, tables, lists, states, local
// times, plain text, and the host paths of F15. Timing (the 15-second refresh) is in
// BoardView.refresh.test.tsx.
import { screen, within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { render } from '../../../test/render';
import { createApi } from '../../api/client';
import { ManualClock } from '../../api/clock';
import { ApiError } from '../../api/errors';
import type { Board } from '../../api/types';
import { expectNoAxeViolations, setupUser } from '../shell/test-utils';
import { BoardView, type BoardViewProps } from './BoardView';
import {
  instantApi,
  makeAgent,
  makeBoard,
  makeHandoff,
  makeNote,
  makeTask,
  manualApi,
  recordedBoard,
  recordedBoardBody,
  settle,
  advance,
} from './board-test-utils';

const REPO = 'repo-c522d9cf';

/** Shows a board the way the app does: inside <main>, which the shell provides. */
async function showBoard(board: Board, props: Partial<BoardViewProps> = {}) {
  const { api, board: spy } = instantApi(() => board);
  const clock = new ManualClock();
  const container = render(
    <main>
      <BoardView api={api} repoKey={REPO} clock={clock} timeZone="UTC" {...props} />
    </main>,
  );
  await settle();
  return { container, clock, spy };
}

const sectionOf = (name: string): HTMLElement => {
  const heading = screen.getByRole('heading', { level: 2, name });
  // The heading's parent is the section's own block.
  if (!heading.parentElement) throw new Error(`heading "${name}" has no parent`);
  return heading.parentElement;
};

const cellTexts = (row: HTMLElement): string[] => within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '');

/** The two lines of a list item: who, what and when, then the text. */
function itemParts(item: HTMLElement): { head: string; text: string } {
  return {
    head: item.querySelector('.board-item__head')?.textContent ?? '',
    text: item.querySelector('.board-item__text')?.textContent ?? '',
  };
}

describe('Board view: structure (ui-contract sections 2 and 4)', () => {
  it('has one h1, "Board", and the h2 sections Agents, Tasks, Open questions, Notes, Handoffs, in that order', async () => {
    await showBoard(recordedBoard());
    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Board']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Agents',
      'Tasks',
      'Open questions',
      'Notes',
      'Handoffs',
    ]);
  });

  it('has a button named "Refresh board" and no other control', async () => {
    await showBoard(recordedBoard());
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Refresh board']);
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('shows agents and tasks as tables, each with a <caption> that names it', async () => {
    await showBoard(recordedBoard());
    for (const name of ['Agents', 'Tasks']) {
      const table = screen.getByRole('table', { name });
      // The element itself, not only a name: aria-labelledby alone would name the table without a caption.
      expect(table.querySelector('caption')?.textContent, `caption of the ${name} table`).toBe(name);
    }
  });

  it('puts each table in a named, focusable scroll region, so a keyboard can scroll it', async () => {
    await showBoard(recordedBoard());
    for (const name of ['Agents', 'Tasks']) {
      const region = screen.getByRole('region', { name });
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(within(region).getByRole('table', { name })).toBeTruthy();
    }
  });

  it('shows open questions, notes and handoffs as lists named after their sections', async () => {
    await showBoard(recordedBoard());
    for (const name of ['Open questions', 'Notes', 'Handoffs']) {
      expect(within(sectionOf(name)).getByRole('list', { name })).toBeTruthy();
    }
  });
});

describe('Board view: the recorded board (a real bridge answer, through the guards)', () => {
  it('shows the agent, with a task and no role, branch or departure', async () => {
    await showBoard(recordedBoard());
    const table = screen.getByRole('table', { name: 'Agents' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Name',
      'Role',
      'Harness',
      'Status',
      'Branch',
      'Task',
      'Last seen',
    ]);
    const [, row] = within(table).getAllByRole('row');
    expect(within(row as HTMLElement).getByRole('rowheader').textContent).toBe('codex');
    // The recording's agent times are Chatter's zoneless UTC; the guard made them ISO, and UTC is the pinned zone.
    expect(cellTexts(row as HTMLElement)).toEqual(['none', 'codex', 'offline', 'none', 'TASK-1: Wire the web client', '2026-10-09 00:00']);
  });

  it('shows the task', async () => {
    await showBoard(recordedBoard());
    const table = screen.getByRole('table', { name: 'Tasks' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'ID',
      'Title',
      'Status',
      'Assignee',
      'Created by',
      'Updated',
    ]);
    const [, row] = within(table).getAllByRole('row');
    expect(within(row as HTMLElement).getByRole('rowheader').textContent).toBe('TASK-1');
    expect(cellTexts(row as HTMLElement)).toEqual(['Wire the web client', 'in_progress', 'codex', 'flan', '2026-10-10 14:06']);
  });

  it('shows the open question', async () => {
    await showBoard(recordedBoard());
    const items = within(screen.getByRole('list', { name: 'Open questions' })).getAllByRole('listitem');
    expect(items.map((item) => itemParts(item))).toEqual([{ head: 'asked by flan, 2026-10-10 14:06', text: 'who owns the auth migration?' }]);
  });

  it('shows the notes in the order the bridge sent them, with their type, author and task', async () => {
    await showBoard(recordedBoard());
    const items = within(screen.getByRole('list', { name: 'Notes' })).getAllByRole('listitem');
    expect(items.map((item) => itemParts(item))).toEqual([
      { head: 'note by flan, task TASK-1, 2026-10-10 14:06', text: 'handed off TASK-1 to codex: API module ready for review' },
      { head: 'decision by flan, 2026-10-10 14:06', text: 'The bridge reads Chatter state read-only' },
    ]);
  });

  it('writes a handoff as "from to to" in words, with its status, branch and task', async () => {
    await showBoard(recordedBoard());
    const items = within(screen.getByRole('list', { name: 'Handoffs' })).getAllByRole('listitem');
    expect(items.map((item) => itemParts(item))).toEqual([
      { head: 'flan to codex, pending, branch m3-client, task TASK-1, 2026-10-10 14:06', text: 'API module ready for review' },
    ]);
    expect(items[0]?.textContent).not.toMatch(/[→>]/);
  });

  it('shows no member or agent as a bot', async () => {
    const { container } = await showBoard(recordedBoard());
    expect(container.textContent).not.toMatch(/\bbot\b/i);
  });
});

describe('Board view: values the bridge sent as null, and agents that left', () => {
  it('says "none", "never" and "unassigned" rather than leaving a cell blank', async () => {
    await showBoard(
      makeBoard({
        agents: [makeAgent({ role: null, kind: null, status: null, branch: null, task: null, last_seen_at: null })],
        tasks: [makeTask({ assignee: null, created_by: null, updated_at: null })],
      }),
    );
    const [, agentRow] = within(screen.getByRole('table', { name: 'Agents' })).getAllByRole('row');
    expect(cellTexts(agentRow as HTMLElement)).toEqual(['none', 'none', 'unknown', 'none', 'none', 'never']);
    const [, taskRow] = within(screen.getByRole('table', { name: 'Tasks' })).getAllByRole('row');
    expect(cellTexts(taskRow as HTMLElement)).toEqual(['Wire the web client', 'in_progress', 'unassigned', 'none', 'none']);
  });

  it('leaves out the task, branch and handoff recipient that an item does not have', async () => {
    await showBoard(
      makeBoard({
        notes: [makeNote({ task_id: null })],
        handoffs: [makeHandoff({ to: null, branch: null, task_id: null })],
      }),
    );
    const [note] = within(screen.getByRole('list', { name: 'Notes' })).getAllByRole('listitem');
    expect(itemParts(note as HTMLElement).head).toBe('decision by flan, 2026-10-10 14:06');
    const [handoff] = within(screen.getByRole('list', { name: 'Handoffs' })).getAllByRole('listitem');
    // No recipient: only who handed it off, not "flan to none".
    expect(itemParts(handoff as HTMLElement).head).toBe('flan, pending, 2026-10-10 14:06');
  });

  it('says in words when an agent has departed, and when', async () => {
    await showBoard(makeBoard({ agents: [makeAgent({ status: 'offline', departed_at: '2026-10-11T09:30:00Z' })] }));
    const [, row] = within(screen.getByRole('table', { name: 'Agents' })).getAllByRole('row');
    expect(cellTexts(row as HTMLElement)[2]).toBe('offline Departed 2026-10-11 09:30');
  });
});

describe('Board view: empty sections', () => {
  it('says so in text for every section, and shows no table', async () => {
    await showBoard(makeBoard());
    expect(screen.queryAllByRole('table')).toEqual([]);
    expect(within(sectionOf('Agents')).getByText('No agents are registered yet.')).toBeTruthy();
    expect(within(sectionOf('Tasks')).getByText('There are no tasks yet.')).toBeTruthy();
    expect(within(sectionOf('Open questions')).getByText('There are no open questions.')).toBeTruthy();
    expect(within(sectionOf('Notes')).getByText('There are no notes yet.')).toBeTruthy();
    expect(within(sectionOf('Handoffs')).getByText('There are no handoffs yet.')).toBeTruthy();
    expect(screen.queryAllByRole('list')).toEqual([]);
  });
});

describe('Board view: agents_error', () => {
  const unavailable = 'chatter agents failed: herdr is not running';

  it('says in a status that agents are unavailable, and shows the bridge\'s message', async () => {
    await showBoard(makeBoard({ agents: [], agents_error: unavailable }));
    const status = within(sectionOf('Agents')).getByRole('status');
    expect(status.textContent).toBe(`Agents are unavailable: ${unavailable}`);
  });

  it('does not claim there are no agents when it could not ask', async () => {
    await showBoard(makeBoard({ agents: [], agents_error: unavailable }));
    expect(screen.queryByText('No agents are registered yet.')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Agents' })).toBeNull();
  });

  it('keeps an empty status in the Agents section when nothing is wrong, so a later error is announced', async () => {
    await showBoard(makeBoard({ agents: [makeAgent()] }));
    const status = within(sectionOf('Agents')).getByRole('status');
    expect(status.textContent).toBe('');
    expect(screen.getByRole('table', { name: 'Agents' })).toBeTruthy();
  });

  it('shows the message when the error arrives on a later refresh, and takes it away when it clears', async () => {
    let answer = makeBoard({ agents: [makeAgent()] });
    const { api } = instantApi(() => answer);
    const clock = new ManualClock();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={clock} timeZone="UTC" />
      </main>,
    );
    await settle();
    const status = within(sectionOf('Agents')).getByRole('status');
    expect(status.textContent).toBe('');

    answer = makeBoard({ agents: [], agents_error: unavailable });
    await advance(clock, 15_000);
    // The same live region, now with text in it.
    expect(within(sectionOf('Agents')).getByRole('status')).toBe(status);
    expect(status.textContent).toBe(`Agents are unavailable: ${unavailable}`);

    answer = makeBoard({ agents: [makeAgent()] });
    await advance(clock, 15_000);
    expect(status.textContent).toBe('');
  });
});

describe('Board view: times are local', () => {
  const board = makeBoard({
    tasks: [makeTask({ updated_at: '2026-10-10T23:30:00Z' })],
    agents: [makeAgent({ last_seen_at: '2026-10-10T23:30:00Z' })],
  });

  it('shows the viewer\'s time zone, date included, and keeps the UTC instant in datetime', async () => {
    await showBoard(board, { timeZone: 'Asia/Tokyo' });
    const [, row] = within(screen.getByRole('table', { name: 'Tasks' })).getAllByRole('row');
    const time = within(row as HTMLElement).getByText('2026-10-11 08:30');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe('2026-10-10T23:30:00Z');
  });

  it('follows the zone it is given: New York is four hours behind UTC in October', async () => {
    await showBoard(board, { timeZone: 'America/New_York' });
    const [, row] = within(screen.getByRole('table', { name: 'Agents' })).getAllByRole('row');
    expect(cellTexts(row as HTMLElement).at(-1)).toBe('2026-10-10 19:30');
  });

  it('uses the 24-hour clock whatever the browser\'s locale', async () => {
    await showBoard(makeBoard({ tasks: [makeTask({ updated_at: '2026-10-10T15:05:00Z' })] }));
    expect(screen.getByText('2026-10-10 15:05')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b[AP]M\b/i);
  });

  it('says when the board was loaded, in local time with seconds', async () => {
    // ManualClock starts at 2026-10-10 12:00:00 UTC.
    await showBoard(makeBoard(), { timeZone: 'Asia/Tokyo' });
    const updated = screen.getByText(/^Updated/);
    expect(updated.textContent).toBe('Updated 21:00:00');
    expect(updated.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-10T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------------- plain text only

const INJECTION = '<img src=x onerror="window.__boardPwned = true"><script>window.__boardPwned = true</script><b>bold</b> https://example.com/pic.png javascript:alert(1)';

/** A board whose every string field carries markup, each marked with the field it is in. */
function hostileBoard(): { board: Board; fields: string[] } {
  const fields: string[] = [];
  const mark = (field: string): string => {
    fields.push(`${INJECTION} ${field}`);
    return `${INJECTION} ${field}`;
  };
  const board = makeBoard({
    agents: [
      makeAgent({
        name: mark('agent.name'),
        kind: mark('agent.kind'),
        role: mark('agent.role'),
        status: mark('agent.status'),
        branch: mark('agent.branch'),
        task: { id: mark('agent.task.id'), title: mark('agent.task.title') },
      }),
    ],
    agents_error: mark('agents_error'),
    tasks: [
      makeTask({
        id: mark('task.id'),
        title: mark('task.title'),
        status: mark('task.status'),
        assignee: mark('task.assignee'),
        created_by: mark('task.created_by'),
      }),
    ],
    questions: [makeNote({ id: 1, author: mark('question.author'), type: 'question', text: mark('question.text'), task_id: mark('question.task_id') })],
    notes: [makeNote({ id: 2, author: mark('note.author'), type: mark('note.type'), text: mark('note.text'), task_id: mark('note.task_id') })],
    handoffs: [
      makeHandoff({
        from: mark('handoff.from'),
        to: mark('handoff.to'),
        summary: mark('handoff.summary'),
        branch: mark('handoff.branch'),
        status: mark('handoff.status'),
        task_id: mark('handoff.task_id'),
      }),
    ],
  });
  return { board, fields };
}

describe('Board view: every field is plain text', () => {
  it('shows markup, scripts and URLs in any field literally and creates no element from them', async () => {
    const { board, fields } = hostileBoard();
    const { container } = await showBoard(board);
    for (const field of fields) expect(container.textContent, field).toContain(field);
    // A parsed <img>, <script> or <b> or an anchor would be an element; none of them is there.
    expect(container.querySelectorAll('img, script, b, a, iframe, object, embed, svg, link, style')).toHaveLength(0);
    expect(Reflect.get(window, '__boardPwned')).toBeUndefined();
  });

  it('shows no attribute taken from a field', async () => {
    const { board } = hostileBoard();
    const { container } = await showBoard(board);
    const attributes = [...container.querySelectorAll('*')].flatMap((element) => [...element.attributes].map((attribute) => attribute.value));
    expect(attributes.filter((value) => value.includes('<') || value.includes('javascript:'))).toEqual([]);
  });

  it('keeps line breaks of a note\'s text for the stylesheet to show', async () => {
    await showBoard(makeBoard({ notes: [makeNote({ text: 'first line\nsecond line' })] }));
    const [item] = within(screen.getByRole('list', { name: 'Notes' })).getAllByRole('listitem');
    expect(itemParts(item as HTMLElement).text).toBe('first line\nsecond line');
  });
});

// ------------------------------------------------------------------------------ host paths (F15)

describe('Board view: host paths are never shown (F15)', () => {
  const CWD = '/home/sentinel/work/agent-cwd';
  const ROOT = '/srv/sentinel/repo-root';

  it('the recording does carry a host path, so the checks below mean something', () => {
    expect(JSON.stringify(recordedBoardBody())).toContain('<scratch>/repo');
  });

  it('shows no cwd or repo_root even from an answer that never went through the guards', async () => {
    const withPaths = {
      ...makeBoard({ agents: [makeAgent()] }),
      // The bridge passes Chatter's agent objects through; these are the fields it should not show.
      agents: [{ ...makeAgent(), cwd: CWD, repo_root: ROOT, pane_id: 'pane-1', workspace_id: 'workspace-1' }],
      repo_root: ROOT,
      cwd: CWD,
    } as unknown as Board;
    await showBoard(withPaths);
    const page = document.body.innerHTML;
    for (const secret of [CWD, ROOT, 'pane-1', 'workspace-1']) expect(page).not.toContain(secret);
    // Still showing the agent itself: the page is not empty for the wrong reason.
    expect(screen.getByRole('rowheader', { name: 'codex' })).toBeTruthy();
  });

  it('shows no path from the recorded answer, read through the real client and its guards', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify(recordedBoardBody()), { status: 200, headers: { 'content-type': 'application/json' } });
    const api = createApi({ getToken: () => null, fetch: fakeFetch });
    const container = render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={new ManualClock()} timeZone="UTC" />
      </main>,
    );
    expect(await screen.findByRole('rowheader', { name: 'codex' })).toBeTruthy();
    expect(container.innerHTML).not.toContain('scratch');
    expect(container.innerHTML).not.toContain('&lt;scratch');
  });
});

// ------------------------------------------------------------------ loading, failing and recovering

describe('Board view: loading and failing', () => {
  it('says it is loading until the first answer, and shows no section yet', async () => {
    const { api } = manualApi();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={new ManualClock()} timeZone="UTC" />
      </main>,
    );
    await settle();
    const loading = screen.getByText('Loading the board');
    expect(loading.getAttribute('role')).toBe('status');
    expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([]);
    // The page already has its heading and its button.
    expect(screen.getByRole('heading', { level: 1, name: 'Board' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh board' })).toBeTruthy();
  });

  it('shows the bridge\'s message in an alert when the first load fails, and still offers Refresh board', async () => {
    const { api, calls } = manualApi();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={new ManualClock()} timeZone="UTC" />
      </main>,
    );
    calls[0]?.reject(new ApiError(404, 'not_found', 'no such repository'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Could not load the board: no such repository');
    expect(screen.queryByText('Loading the board')).toBeNull();
    expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([]);
    expect(screen.getByRole('button', { name: 'Refresh board' })).toBeTruthy();
  });

  it('gives a failure with no message of its own a plain one', async () => {
    const { api, calls } = manualApi();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={new ManualClock()} timeZone="UTC" />
      </main>,
    );
    calls[0]?.reject('boom');
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Could not load the board: unexpected error');
  });

  it('recovers through Refresh board: the board appears, the alert goes', async () => {
    const { api, calls } = manualApi();
    const user = setupUser();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={new ManualClock()} timeZone="UTC" />
      </main>,
    );
    calls[0]?.reject(new ApiError(502, 'chatter_failed', 'chatter failed'));
    await settle();
    await user.click(screen.getByRole('button', { name: 'Refresh board' }));
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(recordedBoard());
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
  });

  it('keeps the last board on screen when a later refresh fails, and says so without an alert', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={clock} timeZone="UTC" />
      </main>,
    );
    calls[0]?.resolve(recordedBoard());
    await settle();
    await advance(clock, 15_000);
    calls[1]?.reject(new ApiError(500, 'internal', 'the bridge broke'));
    await settle();
    // The board is still there ...
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
    // ... with a polite status saying why it is old, and no assertive alert that every retry would repeat.
    expect(screen.queryByRole('alert')).toBeNull();
    const warning = screen.getAllByRole('status').find((status) => status.textContent?.includes('Could not refresh the board'));
    expect(warning?.textContent).toBe('Could not refresh the board: the bridge brokeShowing the board as it was loaded at 12:00:00');
  });

  it('does not announce the same background failure again on each retry, and clears it on success', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={clock} timeZone="UTC" />
      </main>,
    );
    calls[0]?.resolve(recordedBoard());
    await settle();
    await advance(clock, 15_000);
    calls[1]?.reject(new Error('could not reach the bridge'));
    await settle();
    const warning = screen.getAllByRole('status').find((status) => status.textContent?.includes('Could not refresh'));
    await advance(clock, 15_000);
    calls[2]?.reject(new Error('could not reach the bridge'));
    await settle();
    // The very same element: a live region whose node and text did not change is not read out again.
    expect(screen.getAllByRole('status').find((status) => status.textContent?.includes('Could not refresh'))).toBe(warning);

    await advance(clock, 15_000);
    calls[3]?.resolve(recordedBoard());
    await settle();
    expect(screen.queryByText(/Could not refresh/)).toBeNull();
  });
});

describe('Board view: no repository', () => {
  it('says so in text and requests nothing', async () => {
    const { api, board } = instantApi(() => makeBoard());
    const clock = new ManualClock();
    render(
      <main>
        <BoardView api={api} repoKey={null} clock={clock} />
      </main>,
    );
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Board' })).toBeTruthy();
    expect(screen.getByText('No repository is selected, so there is no board to show.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh board' })).toBeNull();
    await advance(clock, 60_000);
    expect(board).not.toHaveBeenCalled();
    expect(clock.scheduled).toBe(0);
  });
});

// ------------------------------------------------------------------------------------ accessibility

describe('Board view: accessibility', () => {
  it('has no axe violations (structural rules) with data in every section', async () => {
    await showBoard(
      makeBoard({
        agents: [makeAgent(), makeAgent({ name: 'claude', departed_at: '2026-10-11T09:30:00Z', task: null })],
        tasks: [makeTask(), makeTask({ id: 'TASK-2', assignee: null })],
        questions: [makeNote({ id: 3, type: 'question', text: 'who owns the auth migration?' })],
        notes: [makeNote({ id: 4, task_id: 'TASK-1' })],
        handoffs: [makeHandoff()],
      }),
    );
    await expectNoAxeViolations();
  });

  it('has no axe violations with the recorded board', async () => {
    await showBoard(recordedBoard());
    await expectNoAxeViolations();
  });

  it('has no axe violations when every section is empty', async () => {
    await showBoard(makeBoard());
    await expectNoAxeViolations();
  });

  it('has no axe violations when agents are unavailable', async () => {
    await showBoard(makeBoard({ agents_error: 'chatter agents failed' }));
    await expectNoAxeViolations();
  });

  it('has no axe violations while loading, after a failed first load, and with a stale board', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    render(
      <main>
        <BoardView api={api} repoKey={REPO} clock={clock} timeZone="UTC" />
      </main>,
    );
    await settle();
    await expectNoAxeViolations();
    calls[0]?.reject(new Error('could not reach the bridge'));
    await settle();
    await expectNoAxeViolations();
    const user = setupUser();
    await user.click(screen.getByRole('button', { name: 'Refresh board' }));
    calls[1]?.resolve(recordedBoard());
    await settle();
    await advance(clock, 15_000);
    calls[2]?.reject(new Error('could not reach the bridge'));
    await settle();
    expect(screen.getByText(/Could not refresh the board/)).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('reaches the button, then each scrollable table, with Tab alone', async () => {
    const user = setupUser();
    await showBoard(recordedBoard());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh board' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Agents' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Tasks' }));
  });
});
