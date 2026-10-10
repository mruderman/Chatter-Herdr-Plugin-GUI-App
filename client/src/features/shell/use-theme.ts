import { useEffect, useState } from 'preact/hooks';
import type { ThemeChoice, ThemeManager } from './theme';

/** Re-renders when the choice changes and hands back what the Settings dialog needs. */
export function useTheme(manager: ThemeManager): { choice: ThemeChoice; setChoice: (choice: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => manager.getChoice());
  useEffect(() => {
    // Re-read once subscribed: a change between the first render and this effect would otherwise be missed.
    setChoiceState(manager.getChoice());
    return manager.subscribe(() => setChoiceState(manager.getChoice()));
  }, [manager]);
  return { choice, setChoice: manager.setChoice };
}
