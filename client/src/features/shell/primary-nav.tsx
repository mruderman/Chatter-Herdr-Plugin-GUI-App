export interface NavItem {
  id: string;
  label: string;
}

export interface PrimaryNavProps {
  items: readonly NavItem[];
  currentId: string;
  onNavigate: (id: string) => void;
}

// Buttons, not links: the app has no router, so choosing a view changes state, not the address.
export function PrimaryNav({ items, currentId, onNavigate }: PrimaryNavProps) {
  return (
    <nav class="app-nav" aria-label="Primary">
      <ul class="app-nav__list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              class="nav-button"
              aria-current={item.id === currentId ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
