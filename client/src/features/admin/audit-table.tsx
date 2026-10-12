import type { AuditEntry } from '../../api/types';
import { describeAuditEntry, type TimeFormatter } from './format';

export interface AuditTableProps {
  /** The visible "Audit log" heading, which is also the table's name. */
  headingId: string;
  /** Newest first, as the bridge sends them; the order is not changed here. */
  entries: readonly AuditEntry[];
  formatTime: TimeFormatter;
}

// Every cell is a text node. The Action column shows the bridge's own action name (member_add,
// token_rotate, everyone ...): it is what the API and the audit documentation call it, and an
// action this page has never heard of still reads correctly. This table has nothing to focus, so its
// scroll region takes focus itself; without that a keyboard user could not reach the columns that
// do not fit on a narrow screen.
export function AuditTable({ headingId, entries, formatTime }: AuditTableProps) {
  return (
    <div class="table-scroll" role="region" aria-label="Audit log, scrollable" tabIndex={0}>
      <table class="admin-table" aria-labelledby={headingId}>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Actor</th>
            <th scope="col">Action</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <time dateTime={entry.at}>{formatTime(entry.at)}</time>
              </td>
              <td>{entry.actor}</td>
              <td>{entry.action}</td>
              <td class="admin-detail">{describeAuditEntry(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
