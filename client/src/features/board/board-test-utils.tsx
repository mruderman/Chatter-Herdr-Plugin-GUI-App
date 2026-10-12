// Shared by the Board tests; nothing in the app imports it.
import { render as preactRender, type ComponentChild } from 'preact';
import { act } from 'preact/test-utils';
import { vi, type Mock } from 'vitest';
import { body } from '../../../test/fixtures/recorded';
import type { Api } from '../../api/client';
import type { ManualClock } from '../../api/clock';
import { parseBoard } from '../../api/guards';
import type { Board, BoardAgent, BoardHandoff, BoardNote, BoardTask } from '../../api/types';

export type BoardApi = Pick<Api, 'board'>;

// ------------------------------------------------------------------------------------------ data

/** What the bridge sent for the board in the recording, host paths and all (`<scratch>/repo`). */
export const recordedBoardBody = (): unknown => body('board');

/** The same, after the guard: what the app really holds. */
export const recordedBoard = (): Board => parseBoard(recordedBoardBody());

export const makeBoard = (parts: Partial<Board> = {}): Board => ({
  repo: 'repo-1',
  epoch: 'epoch-1',
  agents: [],
  agents_error: null,
  tasks: [],
  notes: [],
  questions: [],
  handoffs: [],
  ...parts,
});

export const makeAgent = (parts: Partial<BoardAgent> = {}): BoardAgent => ({
  name: 'codex',
  kind: 'codex',
  role: 'reviewer',
  status: 'working',
  branch: 'm3-client',
  task: { id: 'TASK-1', title: 'Wire the web client' },
  registered_at: '2026-10-09T08:00:00Z',
  last_seen_at: '2026-10-10T14:06:56Z',
  departed_at: null,
  ...parts,
});

export const makeTask = (parts: Partial<BoardTask> = {}): BoardTask => ({
  id: 'TASK-1',
  title: 'Wire the web client',
  status: 'in_progress',
  assignee: 'codex',
  created_by: 'flan',
  created_at: '2026-10-10T14:00:00Z',
  updated_at: '2026-10-10T14:06:56Z',
  ...parts,
});

export const makeNote = (parts: Partial<BoardNote> = {}): BoardNote => ({
  id: 1,
  author: 'flan',
  type: 'decision',
  text: 'The bridge reads Chatter state read-only',
  task_id: null,
  created_at: '2026-10-10T14:06:56Z',
  ...parts,
});

export const makeHandoff = (parts: Partial<BoardHandoff> = {}): BoardHandoff => ({
  id: 1,
  task_id: 'TASK-1',
  from: 'flan',
  to: 'codex',
  summary: 'API module ready for review',
  branch: 'm3-client',
  status: 'pending',
  created_at: '2026-10-10T14:06:56Z',
  ...parts,
});

// ----------------------------------------------------------------------------------------- the API

/** A board route that answers at once, with a spy on it. */
export function instantApi(answer: () => Board | Promise<Board>): { api: BoardApi; board: Mock<BoardApi['board']> } {
  const board = vi.fn<BoardApi['board']>(async () => answer());
  return { api: { board }, board };
}

export interface PendingCall {
  readonly repo: string;
  readonly signal: AbortSignal | undefined;
  resolve(board: Board): void;
  reject(failure: unknown): void;
}

/**
 * A board route whose answers the test hands out, one call at a time. An aborted call rejects like
 * fetch does, unless `honorAbort` is false: that is a route that ignores its signal, so a test can
 * check that the view does not depend on the abort to discard an answer that is no longer wanted.
 */
export function manualApi({ honorAbort = true }: { honorAbort?: boolean } = {}): { api: BoardApi; calls: PendingCall[] } {
  const calls: PendingCall[] = [];
  const api: BoardApi = {
    board: (repo, options) =>
      new Promise<Board>((resolve, reject) => {
        const signal = options?.signal;
        calls.push({ repo, signal, resolve, reject });
        if (honorAbort) signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
      }),
  };
  return { api, calls };
}

// ------------------------------------------------------------------------------------- time and DOM

/** Lets promises settle and Preact re-render. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Moves the clock, then lets whatever it started finish. */
export async function advance(clock: ManualClock, ms: number): Promise<void> {
  await act(async () => {
    clock.advance(ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Renders again into a container `render()` made, as a parent does when its props change. */
export function rerender(container: HTMLElement, ui: ComponentChild): void {
  act(() => {
    preactRender(ui, container);
  });
}

/** Makes the document hidden or visible, as switching tabs does. Undo with `restoreVisibility`. */
export function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState');
}
