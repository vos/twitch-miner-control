import { useCallback, useState } from "react";

/**
 * One of a fixed set of strings, remembered in localStorage.
 *
 * The string sibling of useLocalToggle, and guarded the same way: a
 * browser in private mode throws on access rather than returning null, and
 * a view preference is never worth taking the page down for.
 *
 * The stored value is validated against `options` on the way in. A key
 * left behind by an older build -- or edited by hand -- would otherwise
 * reach the consumer as a choice it has no branch for, showing an empty
 * control above a grid in an order nothing on screen explains.
 */
export function useLocalChoice<T extends string>(
  key: string,
  initial: T,
  options: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return options.includes(stored as T) ? (stored as T) : initial;
    } catch {
      return initial;
    }
  });

  const choose = useCallback((next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // The preference just does not persist. Nothing else breaks.
    }
  }, [key]);

  return [value, choose];
}
