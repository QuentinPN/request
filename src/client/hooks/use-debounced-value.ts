import { useEffect, useState } from 'react';

/** Valeur qui ne suit `value` qu'après `delay` ms sans changement (frappe au clavier). */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
