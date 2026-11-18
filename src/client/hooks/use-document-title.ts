import { DEFAULT_APP_TITLE } from '@shared/app-info.ts';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { setupStateQuery } from '@/lib/session';

/** Titre de l'onglet : celui de l'appli (Réglages › Général), lu dans l'état public de l'installation. */
export function useDocumentTitle() {
  const title = useQuery(setupStateQuery).data?.appTitle ?? DEFAULT_APP_TITLE;
  useEffect(() => {
    document.title = title;
  }, [title]);
}
