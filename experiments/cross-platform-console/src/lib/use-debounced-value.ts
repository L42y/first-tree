import { useEffect, useState } from "react";

/**
 * Trailing-edge debounce for values that drive a network query — typing an
 * `@name` should issue one directory search, not one per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
