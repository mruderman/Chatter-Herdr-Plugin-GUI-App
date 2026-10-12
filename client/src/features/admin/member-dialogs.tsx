import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { MEMBER_KINDS, MEMBER_ROLES, type AddMemberRequest, type Member, type MemberKind, type MemberRole, type UpdateMemberRequest } from '../../api/types';
import { Dialog, MEMBER_KIND_LABEL } from '../shell';
import { ROLE_LABEL } from './format';
import type { Outcome } from './outcome';
import { useSubmit } from './use-submit';
import { addMemberRequest, isEmptyPatch, memberPatch, validateDisplayName, validateHandle, type MemberFormValues } from './validation';

// "Add member" and "Edit {handle}" are one form with different starting values. The handle can be
// typed only when adding. A field is checked when Add or Save is pressed and then again as it is
// edited, so a message is gone as soon as the typo is.

const NOTHING_CHANGED = 'Nothing was changed. Edit a field, or choose Cancel.';
// Member first: it is the safe default, and the order the contract lists.
const ROLES: readonly MemberRole[] = ['member', 'admin'];

const BLANK: MemberFormValues = {
  handle: '',
  displayName: '',
  kind: 'human',
  role: 'member',
  // Members may address agents unless an admin switches it off (D4).
  canAddressAgents: true,
  tailscaleLogin: '',
};

function valuesOf(member: Member): MemberFormValues {
  return {
    handle: member.handle,
    displayName: member.display_name,
    kind: member.kind,
    role: member.role,
    canAddressAgents: member.can_address_agents,
    tailscaleLogin: member.tailscale_login ?? '',
  };
}

// A select can only hold its own options, but the DOM hands back a plain string.
const kindFrom = (value: string, fallback: MemberKind): MemberKind => MEMBER_KINDS.find((kind) => kind === value) ?? fallback;
const roleFrom = (value: string, fallback: MemberRole): MemberRole => MEMBER_ROLES.find((role) => role === value) ?? fallback;

const hintId = (id: string): string => `${id}-hint`;
const errorId = (id: string): string => `${id}-error`;

function describedBy(id: string, hint: boolean, error: boolean): string | undefined {
  const ids = [hint ? hintId(id) : '', error ? errorId(id) : ''].filter((value) => value !== '');
  return ids.length > 0 ? ids.join(' ') : undefined;
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: ComponentChildren;
}

function Field({ id, label, hint, error, children }: FieldProps) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
      {hint !== undefined && (
        <p id={hintId(id)} class="field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId(id)} class="field__error">
          {error}
        </p>
      )}
    </div>
  );
}

interface MemberFormProps {
  /** Set when editing: the handle is fixed and the fields start from this member. */
  member?: Member;
  submitLabel: string;
  onSubmit: (values: MemberFormValues) => Promise<Outcome>;
  onCancel: () => void;
  /** The text under the Kind field; only adding a member has something to say there. */
  kindHint?: string;
  /** The form reports "nothing changed" itself, since only the caller can tell. */
  refuseUnchanged?: (values: MemberFormValues) => boolean;
}

function MemberForm({ member, submitLabel, onSubmit, onCancel, kindHint, refuseUnchanged }: MemberFormProps) {
  const base = useId();
  const id = (name: string): string => `${base}-${name}`;
  const editing = member !== undefined;
  const [values, setValues] = useState<MemberFormValues>(() => (member ? valuesOf(member) : BLANK));
  // Counts the presses of the submit button that stopped at a field; zero means nothing is reported yet.
  const [attempts, setAttempts] = useState(0);
  const handleRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { busy, message, run, refuse } = useSubmit();

  const handleError = attempts > 0 && !editing ? validateHandle(values.handle) : null;
  const nameError = attempts > 0 ? validateDisplayName(values.displayName) : null;

  // After the render that shows the message, so that it is in the page when focus arrives on the field.
  useLayoutEffect(() => {
    if (attempts === 0) return;
    if (handleError) handleRef.current?.focus();
    else if (nameError) nameRef.current?.focus();
  }, [attempts]);

  function set<K extends keyof MemberFormValues>(key: K, value: MemberFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if ((!editing && validateHandle(values.handle)) || validateDisplayName(values.displayName)) {
      setAttempts((count) => count + 1);
      return;
    }
    if (refuseUnchanged?.(values)) {
      refuse(NOTHING_CHANGED);
      return;
    }
    void run(() => onSubmit(values));
  }

  return (
    <form class="stack" noValidate onSubmit={(event) => submit(event)}>
      {!editing && (
        <Field id={id('handle')} label="Handle" hint="Lowercase letters, digits, hyphens and underscores, up to 32 characters. It cannot be changed later." error={handleError}>
          <input
            ref={handleRef}
            id={id('handle')}
            type="text"
            required
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            value={values.handle}
            aria-invalid={handleError ? 'true' : undefined}
            aria-describedby={describedBy(id('handle'), true, Boolean(handleError))}
            onInput={(event) => set('handle', event.currentTarget.value)}
          />
        </Field>
      )}
      <Field id={id('name')} label="Display name" error={nameError}>
        <input
          ref={nameRef}
          id={id('name')}
          type="text"
          required
          autocomplete="off"
          value={values.displayName}
          aria-invalid={nameError ? 'true' : undefined}
          aria-describedby={describedBy(id('name'), false, Boolean(nameError))}
          onInput={(event) => set('displayName', event.currentTarget.value)}
        />
      </Field>
      <Field id={id('kind')} label="Kind" hint={kindHint}>
        <select
          id={id('kind')}
          value={values.kind}
          aria-describedby={describedBy(id('kind'), kindHint !== undefined, false)}
          onChange={(event) => set('kind', kindFrom(event.currentTarget.value, values.kind))}
        >
          {MEMBER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {MEMBER_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </Field>
      <Field id={id('role')} label="Role" hint="Admins manage members and can read every direct message.">
        <select
          id={id('role')}
          value={values.role}
          aria-describedby={describedBy(id('role'), true, false)}
          onChange={(event) => set('role', roleFrom(event.currentTarget.value, values.role))}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
      </Field>
      <Field id={id('login')} label="Tailscale login (optional)" hint="How Tailscale names this person. It lets them sign in without a token.">
        <input
          id={id('login')}
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={values.tailscaleLogin}
          aria-describedby={describedBy(id('login'), true, false)}
          onInput={(event) => set('tailscaleLogin', event.currentTarget.value)}
        />
      </Field>
      <div class="field">
        <label class="check">
          <input
            type="checkbox"
            checked={values.canAddressAgents}
            aria-describedby={hintId(id('agents'))}
            onChange={(event) => set('canAddressAgents', event.currentTarget.checked)}
          />
          Can address agents
        </label>
        <p id={hintId(id('agents'))} class="field__hint">
          Lets this member mention or message Herdr agents. What they write goes into the agent's terminal.
        </p>
      </div>
      {message !== null && (
        <p role="alert" class="alert tone-danger">
          {message}
        </p>
      )}
      <div class="dialog__actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" class="button--primary" aria-disabled={busy ? 'true' : undefined}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export interface AddMemberDialogProps {
  onSubmit: (request: AddMemberRequest) => Promise<Outcome>;
  onCancel: () => void;
}

export function AddMemberDialog({ onSubmit, onCancel }: AddMemberDialogProps) {
  return (
    <Dialog title="Add member" onClose={onCancel}>
      <MemberForm
        submitLabel="Add"
        kindHint="A computational member gets an access token, shown once."
        onSubmit={(values) => onSubmit(addMemberRequest(values))}
        onCancel={onCancel}
      />
    </Dialog>
  );
}

export interface EditMemberDialogProps {
  member: Member;
  onSubmit: (patch: UpdateMemberRequest) => Promise<Outcome>;
  onCancel: () => void;
}

export function EditMemberDialog({ member, onSubmit, onCancel }: EditMemberDialogProps) {
  return (
    <Dialog title={`Edit ${member.handle}`} onClose={onCancel}>
      <MemberForm
        member={member}
        submitLabel="Save"
        refuseUnchanged={(values) => isEmptyPatch(memberPatch(member, values))}
        onSubmit={(values) => onSubmit(memberPatch(member, values))}
        onCancel={onCancel}
      />
    </Dialog>
  );
}
