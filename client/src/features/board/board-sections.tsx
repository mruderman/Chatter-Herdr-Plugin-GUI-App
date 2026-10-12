// The five sections of the board. Every field is picked by name and shown as a text node: nothing
// here iterates an object's keys, so a field the bridge adds later (or one the guards let through by
// mistake, such as an agent's `cwd` or `repo_root`: F15) can never reach the page.
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import type { BoardAgent, BoardHandoff, BoardNote, BoardTask } from '../../api/types';
import { AGENT_COLUMNS, BOARD_TEXT, EMPTY_TEXT, ITEM_WORD, JOIN, PLACEHOLDER, SECTION_TITLE, TASK_COLUMNS } from './board-text';
import { formatLocalDateTime } from './format';

interface TimeProps {
  readonly iso: string;
  readonly timeZone: string | undefined;
}

/** A timestamp as the viewer's local time; the machine-readable value stays in `datetime`. */
export function LocalTime({ iso, timeZone }: TimeProps) {
  return <time dateTime={iso}>{formatLocalDateTime(iso, timeZone)}</time>;
}

function MaybeTime({ iso, timeZone, fallback }: { iso: string | null; timeZone: string | undefined; fallback: string }) {
  return iso === null ? <>{fallback}</> : <LocalTime iso={iso} timeZone={timeZone} />;
}

interface TableProps {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly children: ComponentChildren;
}

// A wide table scrolls sideways inside its own region (WCAG 1.4.10 exempts data tables from reflow),
// and that region has to be focusable or a keyboard cannot scroll it. The caption is the table's
// name and also names the region; it is hidden because the section heading above says the same.
function DataTable({ caption, columns, children }: TableProps) {
  const captionId = useId();
  return (
    <div class="table-scroll board__scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table class="board__table">
        <caption id={captionId} class="visually-hidden">
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="board__section">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ agents

interface AgentsProps {
  readonly agents: readonly BoardAgent[];
  /** Why Chatter could not list agents, or null. */
  readonly error: string | null;
  readonly timeZone: string | undefined;
}

export function AgentsSection({ agents, error, timeZone }: AgentsProps) {
  return (
    <Section title={SECTION_TITLE.agents}>
      {/* Always in the page, filled only when there is something to say: a live region that exists
          before its text arrives is announced far more reliably than one inserted with it. */}
      <div role="status">{error !== null && <p class="alert tone-warning">{`${BOARD_TEXT.agentsUnavailable}${error}`}</p>}</div>
      {agents.length > 0 ? (
        <DataTable caption={SECTION_TITLE.agents} columns={AGENT_COLUMNS}>
          {agents.map((agent) => (
            <tr key={agent.name}>
              <th scope="row">{agent.name}</th>
              <td>{agent.role ?? PLACEHOLDER.none}</td>
              <td>{agent.kind ?? PLACEHOLDER.none}</td>
              <td>
                {agent.status ?? PLACEHOLDER.unknownStatus}
                {agent.departed_at !== null && (
                  <>
                    {' '}
                    <span class="board__cell-note">
                      {ITEM_WORD.departed}
                      <LocalTime iso={agent.departed_at} timeZone={timeZone} />
                    </span>
                  </>
                )}
              </td>
              <td>{agent.branch ?? PLACEHOLDER.none}</td>
              <td>{agent.task === null ? PLACEHOLDER.none : `${agent.task.id}${JOIN.taskIdAndTitle}${agent.task.title}`}</td>
              <td>
                <MaybeTime iso={agent.last_seen_at} timeZone={timeZone} fallback={PLACEHOLDER.neverSeen} />
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        // "No agents" would be wrong when the real answer is "could not ask".
        error === null && <p>{EMPTY_TEXT.agents}</p>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------- tasks

export function TasksSection({ tasks, timeZone }: { tasks: readonly BoardTask[]; timeZone: string | undefined }) {
  return (
    <Section title={SECTION_TITLE.tasks}>
      {tasks.length > 0 ? (
        <DataTable caption={SECTION_TITLE.tasks} columns={TASK_COLUMNS}>
          {tasks.map((task) => (
            <tr key={task.id}>
              <th scope="row" class="board__id">
                {task.id}
              </th>
              <td>{task.title}</td>
              <td>{task.status}</td>
              <td>{task.assignee ?? PLACEHOLDER.unassigned}</td>
              <td>{task.created_by ?? PLACEHOLDER.none}</td>
              <td>
                <MaybeTime iso={task.updated_at} timeZone={timeZone} fallback={PLACEHOLDER.none} />
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p>{EMPTY_TEXT.tasks}</p>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------- questions, notes and handoffs

interface ItemProps {
  /** Who, what and when: the first line. Pieces are joined with commas, which read as pauses. */
  readonly head: readonly ComponentChildren[];
  readonly text: string;
}

function Item({ head, text }: ItemProps) {
  return (
    <li class="board-item">
      <p class="board-item__head">
        {head.map((piece, index) => (
          // The pieces never reorder, so the index is a stable key.
          <span key={index}>
            {index > 0 && JOIN.headPieces}
            {piece}
          </span>
        ))}
      </p>
      <p class="board-item__text">{text}</p>
    </li>
  );
}

function ItemList({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    // role="list" because some screen readers drop the list role from a list whose bullets are hidden.
    // The name is the section's own, so a screen reader's list of lists says which is which.
    <ul class="board-list" role="list" aria-label={label}>
      {children}
    </ul>
  );
}

const taskWords = (taskId: string | null): string[] => (taskId === null ? [] : [`${ITEM_WORD.task}${taskId}`]);

export function QuestionsSection({ questions, timeZone }: { questions: readonly BoardNote[]; timeZone: string | undefined }) {
  return (
    <Section title={SECTION_TITLE.questions}>
      {questions.length > 0 ? (
        <ItemList label={SECTION_TITLE.questions}>
          {questions.map((question) => (
            <Item
              key={question.id}
              head={[
                <span class="board-item__who">{`${ITEM_WORD.askedBy}${question.author}`}</span>,
                ...taskWords(question.task_id),
                <MaybeTime iso={question.created_at} timeZone={timeZone} fallback={PLACEHOLDER.none} />,
              ]}
              text={question.text}
            />
          ))}
        </ItemList>
      ) : (
        <p>{EMPTY_TEXT.questions}</p>
      )}
    </Section>
  );
}

export function NotesSection({ notes, timeZone }: { notes: readonly BoardNote[]; timeZone: string | undefined }) {
  return (
    <Section title={SECTION_TITLE.notes}>
      {notes.length > 0 ? (
        <ItemList label={SECTION_TITLE.notes}>
          {notes.map((note) => (
            <Item
              key={note.id}
              head={[
                <span class="board-item__who">{`${note.type}${ITEM_WORD.by}${note.author}`}</span>,
                ...taskWords(note.task_id),
                <MaybeTime iso={note.created_at} timeZone={timeZone} fallback={PLACEHOLDER.none} />,
              ]}
              text={note.text}
            />
          ))}
        </ItemList>
      ) : (
        <p>{EMPTY_TEXT.notes}</p>
      )}
    </Section>
  );
}

export function HandoffsSection({ handoffs, timeZone }: { handoffs: readonly BoardHandoff[]; timeZone: string | undefined }) {
  return (
    <Section title={SECTION_TITLE.handoffs}>
      {handoffs.length > 0 ? (
        <ItemList label={SECTION_TITLE.handoffs}>
          {handoffs.map((handoff) => (
            <Item
              key={handoff.id}
              head={[
                // In words, not an arrow: the arrow would be read out as a symbol, or not at all.
                // A handoff with no recipient names only who handed it off, not "to none".
                <span class="board-item__who">{handoff.to === null ? handoff.from : `${handoff.from}${ITEM_WORD.to}${handoff.to}`}</span>,
                handoff.status,
                ...(handoff.branch === null ? [] : [`${ITEM_WORD.branch}${handoff.branch}`]),
                ...taskWords(handoff.task_id),
                <MaybeTime iso={handoff.created_at} timeZone={timeZone} fallback={PLACEHOLDER.none} />,
              ]}
              text={handoff.summary}
            />
          ))}
        </ItemList>
      ) : (
        <p>{EMPTY_TEXT.handoffs}</p>
      )}
    </Section>
  );
}
