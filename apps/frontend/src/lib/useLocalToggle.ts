import { useCallback, useState } from "react";

/**
 * A boolean remembered in localStorage.
 *
 * Every access is guarded: a browser in private mode throws on access
 * rather than returning null, and a preference for a panel is never
 * worth taking the page down for.
 */
export function useLocalToggle(key: string, initial: boolean): [boolean, () => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "true";
    } catch {
      return initial;
    }
  });

  const toggle = useCallback(() => {
    setValue((current) => {
      const next = !current;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The preference just does not persist. Nothing else breaks.
      }
      return next;
    });
  }, [key]);

  return [value, toggle];
}
