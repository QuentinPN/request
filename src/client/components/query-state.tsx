import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { isNotConfigured, isNotFound } from '@/lib/http';
import { EmptyState, ErrorState } from './states';

type Empty = { title: string; description?: string };

/**
 * États d'une requête, dans l'ordre : chargement (squelette aux dimensions finales), catalogue non configuré (503),
 * introuvable (404), erreur (« Réessayer »), vide, puis le contenu.
 */
export function QueryState<T>({
  query,
  skeleton,
  errorMessage,
  empty,
  isEmpty,
  notFound = { title: 'Introuvable', description: 'Ce contenu n’existe pas ou plus.' },
  children,
}: {
  query: Pick<UseQueryResult<T>, 'data' | 'error' | 'isPending' | 'refetch'>;
  skeleton: ReactNode;
  errorMessage: string;
  empty?: Empty;
  isEmpty?: (data: T) => boolean;
  notFound?: Empty;
  children: (data: T) => ReactNode;
}) {
  const { data, error, isPending, refetch } = query;
  if (isPending) return skeleton;
  if (data === undefined) {
    if (isNotConfigured(error)) return <CatalogueNotConfigured />;
    if (isNotFound(error)) return <EmptyState {...notFound} />;
    return <ErrorState message={errorMessage} onRetry={() => void refetch()} />;
  }
  if (empty && isEmpty?.(data)) return <EmptyState {...empty} />;
  return children(data);
}

export function CatalogueNotConfigured() {
  return (
    <EmptyState
      title="Le catalogue n’est pas encore configuré"
      description="Un administrateur doit renseigner la clé TMDB dans l’assistant de configuration. Les films et les séries s’afficheront ici ensuite."
    />
  );
}
