// Local time for the board. The bridge sends ISO 8601 UTC; people read their own clock, in the same
// 24-hour form the chat feed uses. The parts are picked out of Intl and put together here, so the
// result never depends on the viewer's locale (digits, order, a.m. and p.m.).

// A fixed locale with Latin digits; it only supplies the numbers, never the layout.
const LOCALE = 'en-GB';

const DATE_TIME = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
const TIME_OF_DAY = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } as const;

type Layout = 'dateTime' | 'timeOfDay';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(layout: Layout, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${layout}|${timeZone ?? ''}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const base = layout === 'dateTime' ? DATE_TIME : TIME_OF_DAY;
    formatter = new Intl.DateTimeFormat(LOCALE, timeZone === undefined ? base : { ...base, timeZone });
    formatters.set(key, formatter);
  }
  return formatter;
}

function parts(formatter: Intl.DateTimeFormat, date: Date): ReadonlyMap<string, string> {
  return new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

/** "2026-10-10 14:06" in `timeZone` (the viewer's own when left out). Text that is not a timestamp is returned as it is. */
export function formatLocalDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = parts(formatterFor('dateTime', timeZone), date);
  return `${p.get('year')}-${p.get('month')}-${p.get('day')} ${p.get('hour')}:${p.get('minute')}`;
}

/** "14:06:56": seconds are shown so that a refresh that changed nothing still visibly happened. */
export function formatLocalTimeOfDay(epochMs: number, timeZone?: string): string {
  const p = parts(formatterFor('timeOfDay', timeZone), new Date(epochMs));
  return `${p.get('hour')}:${p.get('minute')}:${p.get('second')}`;
}
