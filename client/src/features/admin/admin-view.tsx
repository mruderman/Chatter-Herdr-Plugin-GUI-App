import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Api } from '../../api/client';
import type { AddMemberRequest, Member, UpdateMemberRequest } from '../../api/types';
import { AuditTable } from './audit-table';
import { ConfirmDialog } from './confirm-dialog';
import { describeChangeFailure, isRefusal } from './failure';
import { createTimeFormatter } from './format';
import { AddMemberDialog, EditMemberDialog } from './member-dialogs';
import { MembersTable, editButtonId } from './members-table';
import { DONE, type Outcome } from './outcome';
import { ResourceState } from './resource-state';
import { TokenDialog } from './token-dialog';
import { useResource } from './use-resource';
import './admin.css';

/** The routes this view calls; the real `Api` has all of them, a test stub needs only these. */
export type AdminApi = Pick<Api, 'members' | 'addMember' | 'updateMember' | 'revokeMember' | 'rotateToken' | 'audit'>;

export interface AdminViewProps {
  api: AdminApi;
  /** The store's action: after every change the composer and the @-completion must see the new directory. */
  refreshDirectory: () => Promise<void>;
  /** The signed-in member's handle. When it is the target of a revoke or a rotation, the question says so. */
  selfHandle?: string;
  /** Pins the zone times are shown in (tests only); the page's own zone otherwise. */
  timeZone?: string;
}

/** How many audit entries are asked for; the bridge's own default and a number the page says out loud. */
export const AUDIT_LIMIT = 100;

// Said in the polite status after a success. Constants, so that the token dialog's tests can compare the
// whole text: nothing here is ever built from a response.
const ANNOUNCEMENT = {
  added: 'Member added',
  changed: 'Member changed',
  revoked: 'Member revoked',
  rotated: 'Token rotated',
} as const;

const OWN_ACCOUNT = {
  revoke: 'This is your own account, so your access ends at once.',
  rotate: 'This is your own account, so your current token stops working at once.',
  // The store takes the new token over when the answer arrives (wiring/admin-screen.tsx, followRotation), and a
  // session through the tailnet identity never had a token to lose, so this holds for both. It also reconciles
  // the sentence above it, which says that every session on the old token ends. A paragraph of its own, so that
  // the sentence the specs look for stays exactly as it was.
  rotateStays: 'This session stays signed in; any other session that uses the old token ends.',
} as const;

// One dialog at a time. The token of a new or rotated member exists only inside the `token` entry,
// and so only for as long as that entry is the open dialog: whatever closes or replaces it, or removes
// the view, takes the token out of this state with it, and nothing else in the view is given it.
type DialogSpec =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly member: Member }
  | { readonly kind: 'revoke'; readonly member: Member }
  | { readonly kind: 'rotate'; readonly member: Member }
  | { readonly kind: 'token'; readonly handle: string; readonly token: string };

type OpenDialog = DialogSpec & { readonly id: number };

interface Announcement {
  readonly seq: number;
  readonly text: string;
}

export function AdminView({ api, refreshDirectory, selfHandle, timeZone }: AdminViewProps) {
  const membersHeading = useId();
  const auditHeading = useId();
  const members = useResource(() => api.members().then((answer) => answer.members));
  const audit = useResource(() => api.audit({ limit: AUDIT_LIMIT }).then((answer) => answer.entries));
  const formatTime = useMemo(() => createTimeFormatter(timeZone), [timeZone]);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const alive = useRef(true);
  const lastId = useRef(0);
  // The member whose row just lost its Revoke and Rotate buttons; see the effect below.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The question that was just answered returned focus to the Revoke button, and the reload that follows
  // takes that button away. Left alone, focus would fall to the top of the page; the row's Edit button is
  // the nearest thing that is still there. A layout effect, so that focus moves in the same tick that the
  // button goes, and is never on the page itself, not even for a frame, where a screen reader would say so.
  useLayoutEffect(() => {
    const handle = refocus.current;
    if (handle === null || members.data === null) return;
    refocus.current = null;
    const active = document.activeElement;
    const lost = active === null || active === document.body || !active.isConnected;
    if (lost) document.getElementById(editButtonId(handle))?.focus();
  }, [members.data]);

  function openDialog(spec: DialogSpec): void {
    lastId.current += 1;
    setDialog({ ...spec, id: lastId.current });
  }

  const closeDialog = (): void => setDialog(null);
  // A call can finish after its dialog was dismissed, and another dialog may be open by then.
  const closeDialogIfOpen = (id: number): void => setDialog((current) => (current?.id === id ? null : current));

  // What a change that was made, or may have been, asks of the page: the store's directory, so that the
  // composer sees it (asked even when this view has gone, since the composer outlives it), and while the
  // view is here both lists.
  function reloadAfterChange(): void {
    void (async () => {
      try {
        await refreshDirectory();
      } catch {
        // A directory that could not be refreshed stays as it was.
      }
    })();
    if (!alive.current) return;
    members.reload();
    audit.reload();
  }

  function afterChange(text: string): void {
    reloadAfterChange();
    if (!alive.current) return;
    setAnnouncement((previous) => ({ seq: (previous?.seq ?? 0) + 1, text }));
  }

  // Makes the call and turns a failure into an Outcome for the dialog. What a success does is `onSuccess`,
  // which is not inside the try: a bug there must not be reported to the admin as the bridge's refusal.
  async function perform<T>(call: () => Promise<T>, onSuccess: (result: T) => void): Promise<Outcome> {
    let result: T;
    try {
      result = await call();
    } catch (failure) {
      // Anything but the bridge's own refusal may have been made, and its message sends the admin to the
      // lists, which must not still be the ones from before the attempt. A view that has gone has nobody
      // to read that message, so it asks for nothing.
      if (!isRefusal(failure) && alive.current) reloadAfterChange();
      return { ok: false, message: describeChangeFailure(failure) };
    }
    onSuccess(result);
    return DONE;
  }

  const showToken = (handle: string, token: string): void => openDialog({ kind: 'token', handle, token });

  const addMember = (id: number, request: AddMemberRequest): Promise<Outcome> =>
    perform(
      () => api.addMember(request),
      ({ member, token }) => {
        afterChange(ANNOUNCEMENT.added);
        if (token !== null) showToken(member.handle, token);
        else closeDialogIfOpen(id);
      },
    );

  const updateMember = (id: number, handle: string, patch: UpdateMemberRequest): Promise<Outcome> =>
    perform(
      () => api.updateMember(handle, patch),
      () => {
        afterChange(ANNOUNCEMENT.changed);
        closeDialogIfOpen(id);
      },
    );

  const revokeMember = (id: number, handle: string): Promise<Outcome> =>
    perform(
      () => api.revokeMember(handle),
      () => {
        refocus.current = handle;
        afterChange(ANNOUNCEMENT.revoked);
        closeDialogIfOpen(id);
      },
    );

  const rotateToken = (handle: string): Promise<Outcome> =>
    perform(
      () => api.rotateToken(handle),
      ({ token }) => {
        afterChange(ANNOUNCEMENT.rotated);
        showToken(handle, token);
      },
    );

  const adminOnly = members.failure?.adminOnly === true;
  const isSelf = (member: Member): boolean => selfHandle !== undefined && selfHandle === member.handle;

  return (
    <div class="admin stack">
      <h1>Admin</h1>
      {/* Always in the page, so that a change of its text is announced; the keyed paragraph makes the same
          text announced again when the same thing happens twice. Sighted people see the table change. */}
      <div role="status" aria-label="Admin announcements" class="visually-hidden">
        {announcement && <p key={announcement.seq}>{announcement.text}</p>}
      </div>

      <div class="stack">
        <div class="admin-bar">
          <h2 id={membersHeading}>Members</h2>
          {!adminOnly && (
            <button type="button" class="button--primary" onClick={() => openDialog({ kind: 'add' })}>
              Add member
            </button>
          )}
        </div>
        <ResourceState
          resource={members}
          loading="Loading members…"
          empty="There are no members yet."
          adminOnly="Only admins can see and change the members."
          failed="Could not load the members"
        >
          {(list) => (
            <MembersTable
              headingId={membersHeading}
              members={list}
              onEdit={(member) => openDialog({ kind: 'edit', member })}
              onRevoke={(member) => openDialog({ kind: 'revoke', member })}
              onRotate={(member) => openDialog({ kind: 'rotate', member })}
            />
          )}
        </ResourceState>
      </div>

      <div class="stack">
        <h2 id={auditHeading}>Audit log</h2>
        <ResourceState
          resource={audit}
          loading="Loading the audit log…"
          empty="The audit log is empty."
          adminOnly="Only admins can read the audit log."
          failed="Could not load the audit log"
        >
          {(entries) => (
            <>
              <p class="field__hint">
                {`Newest first, in your time zone.${entries.length >= AUDIT_LIMIT ? ` Showing the newest ${AUDIT_LIMIT}; older entries are not listed.` : ''}`}
              </p>
              <AuditTable headingId={auditHeading} entries={entries} formatTime={formatTime} />
            </>
          )}
        </ResourceState>
      </div>

      {dialog?.kind === 'add' && <AddMemberDialog key={dialog.id} onSubmit={(request) => addMember(dialog.id, request)} onCancel={closeDialog} />}
      {dialog?.kind === 'edit' && (
        <EditMemberDialog
          key={dialog.id}
          member={dialog.member}
          onSubmit={(patch) => updateMember(dialog.id, dialog.member.handle, patch)}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <ConfirmDialog
          key={dialog.id}
          title={`Revoke ${dialog.member.handle}?`}
          confirmLabel="Revoke"
          danger
          onConfirm={() => revokeMember(dialog.id, dialog.member.handle)}
          onCancel={closeDialog}
        >
          <p>{`${dialog.member.display_name} (${dialog.member.handle}) loses access at once: the token stops working and any open session ends.`}</p>
          <p>A revoked member cannot be restored from this page, and the handle cannot be used again.</p>
          {isSelf(dialog.member) && <p>{OWN_ACCOUNT.revoke}</p>}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'rotate' && (
        <ConfirmDialog
          key={dialog.id}
          title={`Rotate token for ${dialog.member.handle}?`}
          confirmLabel="Rotate"
          onConfirm={() => rotateToken(dialog.member.handle)}
          onCancel={closeDialog}
        >
          <p>{`The current token for ${dialog.member.handle} stops working at once, and any session that uses it ends. A new token is shown once.`}</p>
          {isSelf(dialog.member) && (
            <>
              <p>{OWN_ACCOUNT.rotate}</p>
              <p>{OWN_ACCOUNT.rotateStays}</p>
            </>
          )}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'token' && <TokenDialog key={dialog.id} handle={dialog.handle} token={dialog.token} onClose={closeDialog} />}
    </div>
  );
}
