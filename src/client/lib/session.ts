import { VIEWER_PATH, type Viewer } from '@shared/auth.ts';
import { SETUP_STATE_PATH, type SetupState } from '@shared/setup.ts';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { AuthRequiredError, apiGet } from './http.ts';

/** Membre connecté, `null` sans session (401). */
export const viewerQuery = queryOptions({
  queryKey: ['viewer'],
  queryFn: async (): Promise<Viewer | null> => {
    try {
      return (await apiGet<{ viewer: Viewer }>(VIEWER_PATH)).viewer;
    } catch (error) {
      if (error instanceof AuthRequiredError) return null;
      throw error;
    }
  },
});

export const setupStateQuery = queryOptions({
  queryKey: ['setup-state'],
  queryFn: () => apiGet<SetupState>(SETUP_STATE_PATH),
});

/** Fin de session (déconnexion ou 401) : plus de membre, et rien de ce qu'il a lu ne reste en cache. */
export function forgetSession(queryClient: QueryClient) {
  queryClient.setQueryData(viewerQuery.queryKey, null);
  queryClient.removeQueries({
    predicate: ({ queryKey: [key] }) => key !== viewerQuery.queryKey[0] && key !== setupStateQuery.queryKey[0],
  });
}

const SAME_ORIGIN = 'http://request.invalid';

/**
 * Chemin de retour après connexion : uniquement une adresse interne. Résolue comme le ferait le navigateur
 * (qui ignore tabulations et retours à la ligne : `/\t/hôte` devient `//hôte`), puis l'origine est comparée.
 */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  try {
    const url = new URL(value, SAME_ORIGIN);
    return url.origin === SAME_ORIGIN ? url.pathname + url.search + url.hash : undefined;
  } catch {
    return undefined;
  }
}

export type GuardRedirect = { to: '/' | '/assistant' } | { to: '/connexion'; retour: string };

/**
 * Où envoyer le navigateur avant d'afficher `path` (`href` = chemin et paramètres), ou `null` pour l'afficher.
 * Seule définition des règles d'accès côté client ; le serveur reste l'autorité (401/403).
 */
export function guardRedirect(
  path: string,
  href: string,
  setup: SetupState,
  viewer: Viewer | null,
): GuardRedirect | null {
  const isOwner = viewer?.capabilities.isOwner === true;
  // Avec un propriétaire, la connexion reste ouverte même sans serveur multimédia (le serveur répond 409) : sinon /assistant renverrait ici.
  if (path === '/connexion') return setup.services.mediaServer || setup.hasOwner ? null : { to: '/assistant' };
  if (path === '/assistant') {
    // Amorçage : sans propriétaire, l'assistant (serveur multimédia seul) est ouvert à tous.
    if (!setup.hasOwner) return null;
    if (!viewer) return { to: '/connexion', retour: href };
    return isOwner ? null : { to: '/' };
  }
  if (!setup.hasOwner) return { to: '/assistant' };
  if (!viewer) return { to: '/connexion', retour: href };
  // Configuration inachevée : le propriétaire garde /compte pour se déconnecter.
  if (isOwner && !setup.complete && path !== '/compte') return { to: '/assistant' };
  // Réglages : le propriétaire, et les gestionnaires des blocages (leur seule section, Blocages).
  if (path === '/reglages' && !isOwner && viewer.capabilities.canManageBlocklist !== true) return { to: '/' };
  // Le serveur ne ferme pas la liste aux membres (ils y voient leurs demandes) : la file d'approbation n'est pas pour eux.
  if (path === '/approbations' && viewer.capabilities.canManageRequests !== true) return { to: '/' };
  return null;
}
