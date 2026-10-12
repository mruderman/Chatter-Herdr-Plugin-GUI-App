// How the lists put times and entries into words. Everything returned is a plain string for a text
// node: nothing here builds markup.
import type { AuditEntry, MemberRole } from '../../api/types';

export const ROLE_LABEL: Readonly<Record<MemberRole, string>> = {
  admin: 'Admin',
  member: 'Member',
};

export type TimeFormatter = (iso: string) => string;

// A fixed layout rather than the browser's locale ones: an audit trail is read for order and exact
// moments, and "2026-10-10 14:06:55" reads the same everywhere. The zone is the page's own unless a
// test pins it.
export function createTimeFormatter(timeZone?: string): TimeFormatter {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (iso) => {
    const date = new Date(iso);
    // The API module only lets ISO timestamps through, but showing the raw text beats showing "NaN".
    if (Number.isNaN(date.getTime())) return iso;
    const found: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) found[part.type] = part.value;
    const get = (type: string): string => found[type] ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  };
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The Detail column: who or what the entry is about, then whatever the bridge recorded with it, as
 * "name: value" pairs. The bridge keeps nothing secret in an entry (tokens are never logged), so
 * everything is shown.
 */
export function describeAuditEntry(entry: AuditEntry): string {
  const pairs: Array<readonly [string, string]> = [];
  if (entry.target !== null) pairs.push(['target', entry.target]);
  if (entry.repo !== null) pairs.push(['repo', entry.repo]);
  if (entry.message_id !== null) pairs.push(['message', String(entry.message_id)]);
  for (const [name, value] of Object.entries(entry.detail ?? {})) pairs.push([name, valueText(value)]);
  return pairs.map(([name, value]) => `${name}: ${value}`).join(', ');
}
