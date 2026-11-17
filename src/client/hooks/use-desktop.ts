import { useSyncExternalStore } from 'react';

// Même seuil que le breakpoint `lg` de Tailwind (64 rem) : la pilule et la barre d'onglets s'y échangent aussi.
const query = '(min-width: 64rem)';

const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};

/** Écran d'ordinateur (≥ lg) ; pour les pages dont la disposition mobile est un autre écran, pas une version réduite. */
export const useDesktop = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => true,
  );
