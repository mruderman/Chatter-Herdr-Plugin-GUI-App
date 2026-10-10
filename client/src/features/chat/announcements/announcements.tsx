// The "Announcements" live region (ui-contract section 3): the store decides what to say and when
// (throttled, never the member's own messages); this only puts its text where a screen reader hears it.
import type { Store, StoreSnapshot } from '../../../state/types';

export const ANNOUNCEMENTS_NAME = 'Announcements';

export interface AnnouncementsProps {
  readonly snapshot: StoreSnapshot;
  /** Unused: the region only reads the snapshot. Taken so every chat component has the same props. */
  readonly store: Store;
}

export function Announcements({ snapshot }: AnnouncementsProps) {
  const announcement = snapshot.announcement;
  return (
    // Always in the page, so the region exists before its first text arrives (a live region added
    // together with its text is often not read).
    <div class="visually-hidden" role="status" aria-live="polite" aria-label={ANNOUNCEMENTS_NAME}>
      {/* A new element for every seq: screen readers read additions, so the same text under a new seq is read again. */}
      {announcement && <p key={announcement.seq}>{announcement.text}</p>}
    </div>
  );
}
