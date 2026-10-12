import type { Member } from '../../api/types';
import { KindBadge } from '../shell';
import { ROLE_LABEL } from './format';

export interface MembersTableProps {
  /** The visible "Members" heading, which is also the table's name. */
  headingId: string;
  members: readonly Member[];
  onEdit: (member: Member) => void;
  onRevoke: (member: Member) => void;
  onRotate: (member: Member) => void;
}

/** The id of a row's Edit button, which the view moves focus to when the buttons beside it go away. */
export const editButtonId = (handle: string): string => `admin-edit-${handle}`;

type MemberRowProps = Pick<MembersTableProps, 'onEdit' | 'onRevoke' | 'onRotate'> & { member: Member };

// The visible text of a row button is short because the row already says whose it is; the name for
// assistive technology and voice control begins with that text (WCAG 2.5.3) and adds the handle.
function MemberRow({ member, onEdit, onRevoke, onRotate }: MemberRowProps) {
  const revoked = member.status === 'revoked';
  return (
    <tr>
      <th scope="row">{member.handle}</th>
      <td>{member.display_name}</td>
      <td>
        <KindBadge kind={member.kind} />
      </td>
      <td>{ROLE_LABEL[member.role]}</td>
      <td>{member.can_address_agents ? 'Yes' : 'No'}</td>
      <td>
        <span class={`badge ${revoked ? 'tone-danger' : 'tone-success'}`}>{revoked ? 'Revoked' : 'Active'}</span>
      </td>
      <td>
        <div class="cluster">
          <button type="button" id={editButtonId(member.handle)} aria-label={`Edit ${member.handle}`} onClick={() => onEdit(member)}>
            Edit
          </button>
          {/* Nothing is left to revoke or to rotate on a revoked member: the bridge would log a second
              revoke and refuse the rotation, and there is no way back. Edit stays, because a revoked
              member's Tailscale login still blocks a new member from using it until it is cleared. */}
          {!revoked && (
            <>
              <button type="button" aria-label={`Revoke ${member.handle}`} onClick={() => onRevoke(member)}>
                Revoke
              </button>
              <button type="button" aria-label={`Rotate token for ${member.handle}`} onClick={() => onRotate(member)}>
                Rotate token
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

export function MembersTable({ headingId, members, onEdit, onRevoke, onRotate }: MembersTableProps) {
  return (
    <div class="table-scroll">
      <table class="admin-table" aria-labelledby={headingId}>
        <thead>
          <tr>
            <th scope="col">Handle</th>
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Role</th>
            <th scope="col">Agents</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <MemberRow key={member.handle} member={member} onEdit={onEdit} onRevoke={onRevoke} onRotate={onRotate} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
