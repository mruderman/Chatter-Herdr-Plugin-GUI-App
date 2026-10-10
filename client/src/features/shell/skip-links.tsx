import type { SkipLinkSpec } from './skip-targets';

export interface SkipLinksProps {
  links: readonly SkipLinkSpec[];
}

// Moving focus in script instead of letting the browser follow the fragment keeps "#chat-messages"
// out of the address bar (the app has no router) and makes a missing target a harmless no-op.
function jumpTo(targetId: string, event: MouseEvent): void {
  event.preventDefault();
  document.getElementById(targetId)?.focus();
}

export function SkipLinks({ links }: SkipLinksProps) {
  return (
    <>
      {links.map((link) => (
        <a key={link.targetId} class="skip-link" href={`#${link.targetId}`} onClick={(event) => jumpTo(link.targetId, event)}>
          {link.label}
        </a>
      ))}
    </>
  );
}
