import { useEffect, useState } from 'react';

/** Trailing debounce — keeps a dragged stepper (or typing) off the RPC. */
export function useDebounced<T>(value: T, delayMs = 220): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return settled;
}
