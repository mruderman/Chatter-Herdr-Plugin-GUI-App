import { describe, expect, it, vi } from 'vitest';
import { createThemeManager, parseThemeChoice, type ThemeEnvironment } from './theme';

// The strings below (the attribute, the storage key, the theme names) are the contract's, written out
// on purpose: a test that used the constants would keep passing if someone changed them.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void data.set(key, value)),
    removeItem: vi.fn((key: string) => void data.delete(key)),
  };
  return { storage: storage as unknown as Storage, spies: storage, data };
}

function setup(stored: Record<string, string> = {}) {
  const root = document.createElement('html');
  const memory = memoryStorage(stored);
  const environment: ThemeEnvironment = { root, getStorage: () => memory.storage };
  return { root, memory, manager: createThemeManager(environment) };
}

describe('theme manager: "System" leaves it to the stylesheet', () => {
  it('has no data-theme attribute when nothing was chosen', () => {
    const { manager, root } = setup();
    manager.start();
    expect(manager.getChoice()).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('removes the attribute when the choice goes back to System', () => {
    const { manager, root } = setup();
    manager.start();
    manager.setChoice('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    manager.setChoice('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('removes an attribute left over from earlier when it starts on System', () => {
    const { manager, root } = setup();
    root.setAttribute('data-theme', 'hc');
    manager.start();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('does not consult the system itself: it works in an environment with no media queries', () => {
    const { manager, root } = setup();
    expect(() => manager.start()).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('theme manager: an explicit choice', () => {
  it('sets data-theme to light, dark or hc', () => {
    const { manager, root } = setup();
    manager.start();
    for (const choice of ['dark', 'hc', 'light'] as const) {
      manager.setChoice(choice);
      expect(manager.getChoice()).toBe(choice);
      expect(root.getAttribute('data-theme')).toBe(choice);
    }
  });

  it('is applied by start() when it was stored earlier', () => {
    const { manager, root } = setup({ 'chatter.theme': 'dark' });
    expect(root.hasAttribute('data-theme')).toBe(false);
    manager.start();
    expect(manager.getChoice()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores a stored value that is not a theme', () => {
    const { manager, root } = setup({ 'chatter.theme': 'neon' });
    manager.start();
    expect(manager.getChoice()).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('theme manager: remembering the choice', () => {
  it('stores the choice under chatter.theme and reads it back in a new manager', () => {
    const first = setup();
    first.manager.setChoice('hc');
    expect(first.memory.data.get('chatter.theme')).toBe('hc');

    const second = setup(Object.fromEntries(first.memory.data));
    second.manager.start();
    expect(second.manager.getChoice()).toBe('hc');
    expect(second.root.getAttribute('data-theme')).toBe('hc');
  });

  it('removes the stored value when the choice goes back to System', () => {
    const { manager, memory } = setup({ 'chatter.theme': 'dark' });
    manager.setChoice('system');
    expect(memory.data.has('chatter.theme')).toBe(false);
  });

  it('writes nothing to storage except the theme name under its own key', () => {
    const { manager, memory } = setup();
    manager.start();
    for (const choice of ['dark', 'hc', 'light', 'system'] as const) manager.setChoice(choice);
    const written = memory.spies.setItem.mock.calls.map(([key, value]) => [key, value]);
    expect(written).toEqual([
      ['chatter.theme', 'dark'],
      ['chatter.theme', 'hc'],
      ['chatter.theme', 'light'],
    ]);
    expect(memory.spies.removeItem.mock.calls).toEqual([['chatter.theme']]);
  });

  it('parseThemeChoice falls back to System for anything unknown', () => {
    expect(parseThemeChoice('dark')).toBe('dark');
    expect(parseThemeChoice('hc')).toBe('hc');
    expect(parseThemeChoice('system')).toBe('system');
    expect(parseThemeChoice('')).toBe('system');
    expect(parseThemeChoice(null)).toBe('system');
    expect(parseThemeChoice(42)).toBe('system');
  });
});

describe('theme manager: storage that fails', () => {
  function failingEnvironment(failure: Partial<Record<'get' | 'set' | 'remove' | 'access', true>>) {
    const root = document.createElement('html');
    const storage = {
      getItem: () => {
        if (failure.get) throw new DOMException('denied', 'SecurityError');
        return 'dark';
      },
      setItem: () => {
        if (failure.set) throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {
        if (failure.remove) throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage;
    const environment: ThemeEnvironment = {
      root,
      getStorage: () => {
        if (failure.access) throw new DOMException('blocked', 'SecurityError');
        return storage;
      },
    };
    return { root, manager: createThemeManager(environment) };
  }

  it('falls back to System when reading throws', () => {
    const { manager, root } = failingEnvironment({ get: true });
    manager.start();
    expect(manager.getChoice()).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('falls back to System when even getting the storage throws', () => {
    const { manager } = failingEnvironment({ access: true });
    expect(() => manager.start()).not.toThrow();
    expect(manager.getChoice()).toBe('system');
  });

  it('still applies and announces a choice when writing throws', () => {
    const { manager, root } = failingEnvironment({ set: true, remove: true });
    const listener = vi.fn();
    manager.subscribe(listener);
    expect(() => manager.setChoice('hc')).not.toThrow();
    expect(root.getAttribute('data-theme')).toBe('hc');
    expect(() => manager.setChoice('system')).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('still applies a choice when the storage cannot be reached at all', () => {
    const { manager, root } = failingEnvironment({ access: true });
    expect(() => manager.setChoice('dark')).not.toThrow();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('theme manager: subscribers', () => {
  it('calls subscribers on every change and not after unsubscribing', () => {
    const { manager } = setup();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    manager.setChoice('dark');
    manager.setChoice('light');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    manager.setChoice('hc');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
