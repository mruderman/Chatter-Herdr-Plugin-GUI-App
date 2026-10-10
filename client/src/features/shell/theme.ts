// Theme manager: remembers an explicit theme choice and puts it on <html> as `data-theme`.
//
// While the choice is "System" there is no attribute at all: the stylesheet's media queries decide
// (forced colours or prefers-contrast: more give the high-contrast tokens, otherwise dark under
// prefers-color-scheme: dark, otherwise light), and they follow the system live with no script. An
// explicit choice sets the attribute to light, dark or hc, which beats the media queries.
//
// Only the theme name is ever stored (it is not sensitive); the token never goes through here. Every
// storage access is guarded because storage can be missing, full or blocked.

export const THEME_CHOICES = ['system', 'light', 'dark', 'hc'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_CHOICE_LABEL: Readonly<Record<ThemeChoice, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  hc: 'High contrast',
};

export const THEME_STORAGE_KEY = 'chatter.theme';
export const THEME_ATTRIBUTE = 'data-theme';

export function parseThemeChoice(value: unknown): ThemeChoice {
  return THEME_CHOICES.find((choice) => choice === value) ?? 'system';
}

export interface ThemeEnvironment {
  /** The element that carries data-theme. */
  root: HTMLElement;
  /** Returns the storage to use, or null when there is none; may throw (browsers block storage). */
  getStorage: () => Storage | null;
}

export interface ThemeManager {
  getChoice: () => ThemeChoice;
  /** Puts the remembered choice on the root: the attribute for an explicit theme, none for "System". */
  start: () => void;
  /** Applies the choice, stores it (the key is removed for "system") and tells subscribers. */
  setChoice: (choice: ThemeChoice) => void;
  /** Subscribers are called after every change of choice. Returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

function defaultEnvironment(): ThemeEnvironment {
  return { root: document.documentElement, getStorage: () => window.localStorage };
}

export function createThemeManager(environment: ThemeEnvironment = defaultEnvironment()): ThemeManager {
  const { root, getStorage } = environment;
  const listeners = new Set<() => void>();

  function readStoredChoice(): ThemeChoice {
    try {
      return parseThemeChoice(getStorage()?.getItem(THEME_STORAGE_KEY));
    } catch {
      return 'system';
    }
  }

  function storeChoice(choice: ThemeChoice): void {
    try {
      const storage = getStorage();
      if (choice === 'system') storage?.removeItem(THEME_STORAGE_KEY);
      else storage?.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // The choice still applies for this page; it just will not survive a reload.
    }
  }

  let choice = readStoredChoice();

  function apply(): void {
    if (choice === 'system') root.removeAttribute(THEME_ATTRIBUTE);
    else root.setAttribute(THEME_ATTRIBUTE, choice);
  }

  return {
    getChoice: () => choice,
    start: apply,
    setChoice(next) {
      choice = parseThemeChoice(next);
      storeChoice(choice);
      apply();
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
