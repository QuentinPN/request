import { EMBY_LINK_PATH, embyLinkResponseSchema, embyWebLink } from '@shared/emby.ts';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiGet } from './http.ts';

/** Adresse publique d'Emby et id du serveur (lisibles par tout membre) ; `link: null` sans adresse publique réglée. */
export const embyLinkQuery = queryOptions({
  queryKey: ['emby-link'],
  queryFn: ({ signal }) => apiGet(EMBY_LINK_PATH, embyLinkResponseSchema, signal),
  staleTime: 5 * 60 * 1000,
});

/**
 * Adresse « Regarder dans Emby » d'un titre (`embyItemId` : champ du contrat), ou `undefined` : titre absent d'Emby,
 * pas d'adresse publique réglée, ou Emby injoignable. N'interroge le serveur que pour un titre qui est dans Emby.
 */
export function useEmbyWatchUrl(embyItemId: string | undefined): string | undefined {
  const link = useQuery({ ...embyLinkQuery, enabled: embyItemId !== undefined }).data?.link;
  return embyItemId !== undefined && link ? embyWebLink(link, embyItemId) : undefined;
}
