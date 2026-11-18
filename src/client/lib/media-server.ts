import { WATCH_LINK_PATH, watchLinkResponseSchema, watchUrl } from '@shared/media-server.ts';
import { mediaServerKindLabels } from '@shared/settings.ts';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiGet } from './http.ts';
import { setupStateQuery } from './session.ts';

/** Type et id du serveur, adresse publique (lisibles par tout membre) ; `link: null` sans lien possible. */
export const watchLinkQuery = queryOptions({
  queryKey: ['watch-link'],
  queryFn: ({ signal }) => apiGet(WATCH_LINK_PATH, watchLinkResponseSchema, signal),
  staleTime: 5 * 60 * 1000,
});

/**
 * Adresse « Regarder dans… » d'un titre (`embyItemId` : champ du contrat, id de l'élément sur le serveur), ou
 * `undefined` : titre absent du serveur, pas d'adresse publique réglée (Emby, Jellyfin), ou serveur injoignable.
 * N'interroge le serveur que pour un titre qui y est.
 */
export function useWatchUrl(embyItemId: string | undefined): string | undefined {
  const link = useQuery({ ...watchLinkQuery, enabled: embyItemId !== undefined }).data?.link;
  return embyItemId !== undefined && link ? watchUrl(link, embyItemId) : undefined;
}

/** Type du serveur multimédia choisi (état public de l'installation, déjà chargé par le garde), `null` sans réglage. */
export function useMediaServerKind() {
  return useQuery(setupStateQuery).data?.mediaServerKind ?? null;
}

/** Nom affiché du serveur choisi (« Jellyfin ») ; « serveur multimédia » tant qu'aucun n'est configuré. */
export function useMediaServerName(): string {
  const kind = useMediaServerKind();
  return kind ? mediaServerKindLabels[kind] : 'serveur multimédia';
}
