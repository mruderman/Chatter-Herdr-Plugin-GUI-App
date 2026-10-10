// Ids the skip links jump to. The chat feed and the message box must carry the first two: that is a
// contract between the shell and the chat view (docs/ui-contract.md names the links, not the ids), so
// the chat view imports these constants instead of repeating the strings.
export const SKIP_TARGET = {
  /** The `log` named "Messages" (focusable). */
  messages: 'chat-messages',
  /** The textarea labelled "Message". */
  composer: 'chat-message-box',
  /** The shell's own <main>; used by the generic skip link and as the fallback for focus return. */
  main: 'main-content',
} as const;

export interface SkipLinkSpec {
  label: string;
  targetId: string;
}

/** The two links the contract lists as the first tab stops of the chat view. */
export const CHAT_SKIP_LINKS: readonly SkipLinkSpec[] = [
  { label: 'Skip to messages', targetId: SKIP_TARGET.messages },
  { label: 'Skip to message box', targetId: SKIP_TARGET.composer },
];

/** Board, Members and Admin have no feed or message box, so they get one link to the view itself. */
export const MAIN_SKIP_LINKS: readonly SkipLinkSpec[] = [{ label: 'Skip to main content', targetId: SKIP_TARGET.main }];
