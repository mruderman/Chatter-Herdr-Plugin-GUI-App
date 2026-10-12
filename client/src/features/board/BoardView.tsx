import { useEffect, useRef, useState } from 'preact/hooks';
import type { Api } from '../../api/client';
import { systemClock, type Clock } from '../../api/clock';
import './board.css';
import { AgentsSection, HandoffsSection, NotesSection, QuestionsSection, TasksSection } from './board-sections';
import { createBoardLoader, LOADING, type BoardLoader, type BoardState } from './board-loader';
import { BOARD_TEXT } from './board-text';
import { formatLocalTimeOfDay } from './format';

export interface BoardViewProps {
  /** Only `board` is called, so a test can pass just that. */
  readonly api: Pick<Api, 'board'>;
  /** The selected repository; null when there is none, which shows a text and requests nothing. */
  readonly repoKey: string | null;
  /** Time for the 15-second refresh. Defaults to the real clock. */
  readonly clock?: Clock;
  /** Tests pin this; leave it out to show the viewer's own time zone. */
  readonly timeZone?: string;
}

// Read-only view of a repository's agents, tasks, open questions, notes and handoffs (docs/ui-contract.md
// section 4). Which repository is shown is the caller's business: this view never changes it.
export function BoardView({ api, repoKey, clock = systemClock, timeZone }: BoardViewProps) {
  if (repoKey === null) {
    return (
      <div class="board stack">
        <h1>{BOARD_TEXT.title}</h1>
        <p>{BOARD_TEXT.noRepository}</p>
      </div>
    );
  }
  // Keyed by repository: another repository gets a fresh panel, so the old board is gone at once and
  // an answer that was still on its way for it has nowhere to land.
  return <BoardPanel key={repoKey} api={api} repoKey={repoKey} clock={clock} timeZone={timeZone} />;
}

interface PanelProps {
  readonly api: Pick<Api, 'board'>;
  readonly repoKey: string;
  readonly clock: Clock;
  readonly timeZone: string | undefined;
}

/** What the last Refresh press came to; `seq` changes with each, so a repeat is announced again. */
interface Outcome {
  readonly seq: number;
  readonly ok: boolean;
}

function BoardPanel({ api, repoKey, clock, timeZone }: PanelProps) {
  const [state, setState] = useState<BoardState>(LOADING);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const loader = useRef<BoardLoader | null>(null);
  // The loader restarts only when the repository changes. A parent that builds a new `api` or
  // `clock` object on every render would otherwise restart it, and so fetch again, on every render.
  const latest = useRef({ api, clock });
  latest.current = { api, clock };

  useEffect(() => {
    const created = createBoardLoader({
      api: { board: (repo, options) => latest.current.api.board(repo, options) },
      repoKey,
      clock: { now: () => latest.current.clock.now(), schedule: (callback, ms) => latest.current.clock.schedule(callback, ms) },
      onState: (next, requested) => {
        setState(next);
        if (requested) setOutcome((previous) => ({ seq: (previous?.seq ?? 0) + 1, ok: next.phase === 'ready' && next.refreshError === null }));
      },
    });
    loader.current = created;
    return () => {
      created.dispose();
      loader.current = null;
    };
  }, [repoKey]);

  // A failure shown on screen is announced when it appears, and again only after someone pressed
  // Refresh and it failed again: the key changes with each press, not with each background retry.
  const pressKey = outcome?.seq ?? 0;

  return (
    <div class="board stack">
      <h1>{BOARD_TEXT.title}</h1>
      <div class="board__toolbar cluster">
        <button type="button" onClick={() => loader.current?.refresh()}>
          {BOARD_TEXT.refreshButton}
        </button>
        {state.phase === 'ready' && (
          <p class="field__hint board__updated">
            {BOARD_TEXT.updated}
            <time dateTime={new Date(state.loadedAt).toISOString()}>{formatLocalTimeOfDay(state.loadedAt, timeZone)}</time>
          </p>
        )}
      </div>
      {/* Off screen and always present: "Board refreshed" is for whoever pressed Refresh and cannot see the page change. */}
      <div role="status" class="visually-hidden">
        {outcome?.ok === true && <span key={outcome.seq}>{BOARD_TEXT.refreshed}</span>}
      </div>
      {state.phase === 'loading' && <p role="status">{BOARD_TEXT.loading}</p>}
      {state.phase === 'failed' && (
        <p key={pressKey} role="alert" class="alert tone-danger">
          {`${BOARD_TEXT.loadFailed}${state.message}`}
        </p>
      )}
      {state.phase === 'ready' && (
        <>
          {state.refreshError !== null && (
            <div key={pressKey} role="status" class="alert tone-warning">
              <p>{`${BOARD_TEXT.refreshFailed}${state.refreshError}`}</p>
              <p>
                {BOARD_TEXT.showingLoadedAt}
                <time dateTime={new Date(state.loadedAt).toISOString()}>{formatLocalTimeOfDay(state.loadedAt, timeZone)}</time>
              </p>
            </div>
          )}
          <AgentsSection agents={state.board.agents} error={state.board.agents_error} timeZone={timeZone} />
          <TasksSection tasks={state.board.tasks} timeZone={timeZone} />
          <QuestionsSection questions={state.board.questions} timeZone={timeZone} />
          <NotesSection notes={state.board.notes} timeZone={timeZone} />
          <HandoffsSection handoffs={state.board.handoffs} timeZone={timeZone} />
        </>
      )}
    </div>
  );
}
