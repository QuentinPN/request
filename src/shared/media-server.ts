import { z } from 'zod';
import type { Viewer } from './auth.ts';
import { embyWebLink, jellyfinWebLink } from './emby.ts';
import { type MediaServerKind, mediaServerKinds } from './settings.ts';

/**
 * Ce qui permet au navigateur d'un membre de bâtir le lien « Regarder dans… » : type du serveur, son id (`serverId`
 * d'Emby/Jellyfin, `machineIdentifier` de Plex) et, pour Emby et Jellyfin, l'adresse publique (Plex passe par
 * app.plex.tv).
 */
export const watchLinkSchema = z.object({
  kind: z.enum(mediaServerKinds),
  serverId: z.string(),
  publicUrl: z.string().nullable(),
});
export type WatchLink = z.infer<typeof watchLinkSchema>;

/** `null` : rien de configuré, pas d'adresse publique (Emby, Jellyfin), ou serveur injoignable : aucun lien. */
export const watchLinkResponseSchema = z.object({ link: watchLinkSchema.nullable() });
export type WatchLinkResponse = z.infer<typeof watchLinkResponseSchema>;

export const WATCH_LINK_PATH = '/api/media-server/link';

/** Lien « Regarder dans Plex » : l'interface web de Plex (app.plex.tv), qui joint le serveur par son id. */
export const plexWebLink = (machineId: string, ratingKey: string): string =>
  `https://app.plex.tv/desktop#!/server/${encodeURIComponent(machineId)}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;

/** Adresse « Regarder dans… » d'un titre (`itemId` : id de l'élément sur le serveur), `undefined` sans lien possible. */
export function watchUrl(link: WatchLink, itemId: string): string | undefined {
  if (link.kind === 'plex') return plexWebLink(link.serverId, itemId);
  if (!link.publicUrl) return undefined;
  const target = { publicUrl: link.publicUrl, serverId: link.serverId };
  return link.kind === 'emby' ? embyWebLink(target, itemId) : jellyfinWebLink(target, itemId);
}

/** Connexion des membres : identifiant et mot de passe (Emby, Jellyfin) ou code PIN plex.tv (Plex). */
export const loginMethodOf = (kind: MediaServerKind): 'password' | 'plex' => (kind === 'plex' ? 'plex' : 'password');

// --- Connexion Plex par code PIN (plex.tv) ---

export const PLEX_PIN_PATH = '/api/auth/plex/pin';
/**
 * Échange du code créé par ce navigateur : il est désigné par un cookie signé posé à la création (jamais par l'adresse
 * ni par l'id plex.tv).
 */
export const PLEX_PIN_CHECK_PATH = `${PLEX_PIN_PATH}/check`;

/** Code créé : la fenêtre app.plex.tv à ouvrir (`authUrl`), le cookie du navigateur désignant le code. */
export interface PlexPinCreated {
  authUrl: string;
  /** ISO 8601 : au-delà, le code ne vaut plus rien. */
  expiresAt: string;
}

/** État d'un code : pas encore validé dans la fenêtre Plex, ou validé (session ouverte, membre connecté). */
export type PlexPinState = { status: 'pending' } | { status: 'authorized'; viewer: Viewer };

/** Intervalle d'interrogation du serveur par le client pendant l'attente. */
export const PLEX_PIN_POLL_MS = 2000;
