// The Chat view's composer (ui-contract sections 3 and 8): the "To" select, the message box with its
// @-suggestions, Send, and the "Send error" alert. It reads the snapshot and calls the store's actions.
// It decides nothing the bridge decides (who may use @everyone or address an agent, whether a message
// is empty or too long): every draft goes to the store, and a refusal comes back as `sendError`, in the
// bridge's own words, with the draft still in the box.
import type { TargetedInputEvent, TargetedKeyboardEvent, TargetedSubmitEvent } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { CHANNEL, type Store, type StoreSnapshot } from '../../../state/types';
import { SKIP_TARGET } from '../../shell';
import { insertMention, matchCandidates, mentionAt, mentionCandidates, type MentionCandidate, type MentionContext } from './mentions';
import { directConversationWith, recipientOf, recipientOptions } from './recipients';
import './composer.css';

export interface ComposerProps {
  snapshot: StoreSnapshot;
  store: Store;
}

/** Names and texts the contract fixes, and the composer's own hint. */
export const COMPOSER_TEXT = {
  form: 'Message composer',
  to: 'To',
  message: 'Message',
  send: 'Send',
  suggestions: 'Mention suggestions',
  sendError: 'Send error',
  sendErrorPrefix: 'Not sent: ',
  hint: 'Enter sends. Shift+Enter starts a new line. Type @ to mention someone.',
} as const;

/** SPEC section 6. The bridge enforces it on the trimmed text (bridge/src/policy.js); the composer only says so. */
export const MAX_BODY = 8_000;

function readOnlyText(a: string, b: string): string {
  return `Read-only: a conversation between ${a} and ${b}`;
}

function tooLongText(length: number): string {
  return `${length.toLocaleString('en')} characters; the limit is ${MAX_BODY.toLocaleString('en')}.`;
}

// Safari ends a composition before the keydown that confirmed it, and marks that keydown with keyCode
// 229 instead of isComposing; either one means the key belongs to the IME.
const IME_KEY_CODE = 229;
const KEY = { enter: 'Enter', tab: 'Tab', escape: 'Escape', down: 'ArrowDown', up: 'ArrowUp' } as const;
// Keys that move the caret: the list described the word the caret was in, so it closes.
const CARET_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const INSERTING = 'insert';
const COMPOSITION_END = 'compositionend';

interface Suggesting {
  readonly context: MentionContext;
  readonly active: number;
}

/** The mention under the caret of `field`, unless the member dismissed the list since they last typed. */
function suggestionAt(field: HTMLTextAreaElement, dismissed: boolean): Suggesting | null {
  const caret = field.selectionStart;
  const context = !dismissed && caret === field.selectionEnd ? mentionAt(field.value, caret) : null;
  return context ? { context, active: 0 } : null;
}

/** What stays in the box after a send succeeded: nothing, unless the member went on typing while it was in flight. */
function remainderAfterSend(current: string, sent: string): string {
  if (current === sent) return '';
  return current.startsWith(sent) ? current.slice(sent.length).trimStart() : current;
}

export function Composer({ snapshot, store }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toId = useId();
  const listId = useId();
  const hintId = useId();
  const countId = useId();
  const alertId = useId();

  // Each piece of state the async send reads after its await is mirrored in a ref, so it reads the
  // present value rather than the one captured when the send began.
  const [draft, setDraftState] = useState('');
  const draftRef = useRef('');
  const [held, setHeldState] = useState<string | null>(null);
  const heldRef = useRef<string | null>(null);
  const [suggesting, setSuggesting] = useState<Suggesting | null>(null);
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState(0);
  const [, setRenders] = useState(0);
  const sendingRef = useRef(false);
  const dismissedRef = useRef(false);
  const awaitingDmRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const me = snapshot.session.status === 'signed-in' ? snapshot.session.me : null;
  const selected = snapshot.conversations.find((conversation) => conversation.id === snapshot.selectedConversation) ?? null;
  // A recipient chosen in "To" who has no conversation yet wins over the selected conversation's.
  const recipient = held ?? (selected ? recipientOf(selected) : null);
  const usable = me !== null && recipient !== null;

  const matches = usable && me && suggesting ? matchCandidates(mentionCandidates(me, snapshot.directory), suggesting.context.prefix) : [];
  const list = suggesting && matches.length > 0 ? { matches, active: Math.min(suggesting.active, matches.length - 1) } : null;
  const optionId = (index: number): string => `${listId}-option-${index}`;

  const length = draft.trim().length;
  const tooLong = length > MAX_BODY;
  // Hidden while a send is in flight, so every failure inserts a fresh alert and is announced again,
  // even when it repeats the last one word for word.
  const sendError = pending ? null : snapshot.sendError;
  const describedBy = [hintId, tooLong ? countId : null, sendError ? alertId : null].filter(Boolean).join(' ');

  function setDraft(text: string): void {
    draftRef.current = text;
    setDraftState(text);
  }

  function setHeld(handle: string | null): void {
    heldRef.current = handle;
    setHeldState(handle);
  }

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Another conversation or repo: "To" follows it again, and a DM waiting to be opened is forgotten.
  useEffect(() => {
    setHeld(null);
    awaitingDmRef.current = null;
  }, [snapshot.selectedRepo, snapshot.selectedConversation]);

  // The first message to a new recipient creates the DM; the store may list it only in a later snapshot.
  useEffect(() => {
    const peer = awaitingDmRef.current;
    if (peer === null) return;
    const dm = directConversationWith(snapshot.conversations, peer);
    if (!dm) return;
    awaitingDmRef.current = null;
    store.selectConversation(dm.id);
  }, [snapshot.conversations, store]);

  const activeOption = list ? optionId(list.active) : null;
  useEffect(() => {
    // jsdom has no scrollIntoView. In a browser this keeps the active option on screen in a long list.
    if (activeOption) document.getElementById(activeOption)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOption]);

  // Preact takes an event's name from the element's on<name> property, and textareas have no
  // oncompositionend, so an onCompositionEnd prop would listen for "CompositionEnd" and never fire.
  // A new textarea is made each time the form comes back from the read-only notice.
  const formShown = selected?.kind !== 'observed';
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return undefined;
    const onCompositionEnd = (): void => {
      // The composition put text in, which counts as typing; the list was kept out of the IME's way until now.
      dismissedRef.current = false;
      setSuggesting(suggestionAt(field, false));
    };
    field.addEventListener(COMPOSITION_END, onCompositionEnd);
    return () => field.removeEventListener(COMPOSITION_END, onCompositionEnd);
  }, [formShown]);

  function accept(choice: MentionCandidate): void {
    const field = textareaRef.current;
    setSuggesting(null);
    if (!field) return;
    // Taken again now: only the word under the caret is replaced, wherever the caret has gone since.
    const caret = field.selectionStart;
    const context = caret === field.selectionEnd ? mentionAt(field.value, caret) : null;
    if (!context) return;
    const next = insertMention(field.value, context, choice.value);
    // Written to the field first, so the render that follows finds the value already there and leaves the caret alone.
    field.value = next.text;
    field.setSelectionRange(next.caret, next.caret);
    setDraft(next.text);
    field.focus();
  }

  function openDirect(peer: string): void {
    const dm = directConversationWith(store.getSnapshot().conversations, peer);
    if (dm) store.selectConversation(dm.id);
    else awaitingDmRef.current = peer;
  }

  async function send(): Promise<void> {
    if (sendingRef.current || !usable || recipient === null) return;
    const to = recipient;
    const body = draftRef.current;
    sendingRef.current = true;
    setPending(true);
    setSuggesting(null);
    let accepted = false;
    try {
      accepted = await store.send({ to, body });
    } catch {
      // The contract resolves false instead of rejecting. A rejection is taken the same way: the draft stays.
    }
    sendingRef.current = false;
    if (!mountedRef.current) return;
    if (accepted) {
      setDraft(remainderAfterSend(draftRef.current, body));
      // Still held means the member did not pick another conversation while the send was in flight.
      if (heldRef.current === to) openDirect(to);
    } else {
      setFailures((count) => count + 1);
    }
    setPending(false);
  }

  function chooseRecipient(value: string): void {
    setHeld(null);
    awaitingDmRef.current = null;
    const conversation =
      value === CHANNEL
        ? snapshot.conversations.find((candidate) => candidate.kind === 'channel')
        : directConversationWith(snapshot.conversations, value);
    if (conversation) store.selectConversation(conversation.id);
    else if (value !== CHANNEL) setHeld(value);
    // Preact puts a select back to its `value` only when it renders, so render even if nothing changed.
    setRenders((count) => count + 1);
  }

  function onInput(event: TargetedInputEvent<HTMLTextAreaElement>): void {
    const field = event.currentTarget;
    setDraft(field.value);
    // After Escape the list stays shut until something is typed (ui-contract section 8); deleting is not typing.
    if ((event.inputType ?? '').startsWith(INSERTING)) dismissedRef.current = false;
    // The IME owns the keys while it composes; the list comes back at compositionend.
    setSuggesting(event.isComposing ? null : suggestionAt(field, dismissedRef.current));
  }

  function onKeyDown(event: TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.isComposing || event.keyCode === IME_KEY_CODE) return;
    const choice = list ? list.matches[list.active] : undefined;
    if (list && choice) {
      if (event.key === KEY.down || event.key === KEY.up) {
        event.preventDefault();
        const step = event.key === KEY.down ? 1 : -1;
        const count = list.matches.length;
        setSuggesting((current) => current && { ...current, active: (Math.min(current.active, count - 1) + step + count) % count });
        return;
      }
      if ((event.key === KEY.enter || event.key === KEY.tab) && !event.shiftKey) {
        event.preventDefault();
        accept(choice);
        return;
      }
      if (event.key === KEY.escape) {
        event.preventDefault();
        dismissedRef.current = true;
        setSuggesting(null);
        return;
      }
      if (CARET_KEYS.has(event.key)) setSuggesting(null);
    }
    if (event.key === KEY.enter && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function onSubmit(event: TargetedSubmitEvent<HTMLFormElement>): void {
    // Always prevented: the CSP has form-action 'none', and the store does the sending.
    event.preventDefault();
    // A click on Send leaves focus on the button; the message box is where the next message is written.
    textareaRef.current?.focus();
    void send();
  }

  if (selected?.kind === 'observed') {
    // Nothing to compose in someone else's DM. The notice takes the box's id, so "Skip to message box"
    // lands on the reason there is no box instead of on nothing.
    return (
      <p id={SKIP_TARGET.composer} tabIndex={-1} class="composer__read-only">
        {readOnlyText(selected.from, selected.to)}
      </p>
    );
  }

  return (
    <form class="composer" aria-label={COMPOSER_TEXT.form} onSubmit={onSubmit}>
      <div class="field composer__to">
        <label for={toId}>{COMPOSER_TEXT.to}</label>
        <select id={toId} value={recipient ?? ''} disabled={!usable} onChange={(event) => chooseRecipient(event.currentTarget.value)}>
          {recipientOptions(me, snapshot.directory, recipient).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for={SKIP_TARGET.composer}>{COMPOSER_TEXT.message}</label>
        {/* The combobox role only while the list shows: axe 4.13 allows no role on a textarea, so a permanent one fails it. */}
        <textarea
          ref={textareaRef}
          id={SKIP_TARGET.composer}
          class="composer__input"
          rows={2}
          value={draft}
          disabled={!usable}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          role={list ? 'combobox' : undefined}
          aria-expanded={list ? 'true' : undefined}
          aria-controls={list ? listId : undefined}
          aria-activedescendant={activeOption ?? undefined}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onBlur={() => setSuggesting(null)}
          onClick={() => setSuggesting(null)}
        />
        {list && (
          // mousedown would take focus out of the message box before the click could pick the option.
          <ul id={listId} role="listbox" aria-label={COMPOSER_TEXT.suggestions} class="mention-list" onMouseDown={(event) => event.preventDefault()}>
            {list.matches.map((choice, index) => (
              <li
                key={choice.value}
                id={optionId(index)}
                role="option"
                aria-selected={index === list.active ? 'true' : 'false'}
                class="mention-option"
                onClick={() => accept(choice)}
              >
                {choice.label}
              </li>
            ))}
          </ul>
        )}
        <p id={hintId} class="field__hint">
          {COMPOSER_TEXT.hint}
        </p>
        {tooLong && (
          <p id={countId} class="field__hint composer__count">
            {tooLongText(length)}
          </p>
        )}
      </div>
      <div class="composer__actions">
        <button type="submit" class="button--primary" disabled={!usable} aria-disabled={pending ? 'true' : undefined}>
          {COMPOSER_TEXT.send}
        </button>
      </div>
      {sendError && (
        <p key={failures} id={alertId} role="alert" aria-label={COMPOSER_TEXT.sendError} class="alert tone-danger">
          {`${COMPOSER_TEXT.sendErrorPrefix}${sendError.message}`}
        </p>
      )}
    </form>
  );
}
