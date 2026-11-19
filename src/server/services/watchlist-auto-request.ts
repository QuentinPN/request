import type { MediaType } from '../../shared/media.ts';
import type { AutoRequestOutcome } from '../../shared/watchlist.ts';
import { HttpError } from '../lib/api-errors.ts';
import type { SessionViewer } from '../plugins/auth.ts';
import type { createRequests } from './requests.ts';

type CreateRequest = ReturnType<typeof createRequests>['create'];

/** L'option est active ET le droit tenu : retiré, le droit suspend l'option (elle reprend si le droit revient). */
export const autoRequestEnabled = ({ user, capabilities }: SessionViewer) =>
  capabilities.canAutoRequestWatchlist && user.watchlistAutoRequest;

/**
 * Demande automatique d'un titre qui vient d'être ajouté à « Ma liste » : une demande normale du membre (qualité
 * normale ; série : toutes les saisons diffusées encore à demander), soumise aux mêmes règles que la feuille de demande
 * (droits, quota, titres bloqués, approbation automatique). Un refus n'est jamais une erreur de l'ajout : il revient avec
 * son motif. `undefined` : option inactive, rien n'a été tenté.
 */
export function createAutoRequester(deps: { create: CreateRequest; onUnexpectedError: (error: unknown) => void }) {
  return async function autoRequest(
    viewer: SessionViewer,
    type: MediaType,
    tmdbId: number,
  ): Promise<AutoRequestOutcome | undefined> {
    if (!autoRequestEnabled(viewer)) return undefined;
    try {
      const { changed } = await deps.create(
        viewer,
        type === 'movie' ? { type, tmdbId, is4k: false } : { type, tmdbId, seasons: 'all', is4k: false },
      );
      // Une demande déjà en cours (double clic, titre déjà demandé par ce membre) ne change rien.
      return changed ? { status: 'requested' } : { status: 'skipped', reason: 'Ce titre est déjà demandé' };
    } catch (error) {
      if (error instanceof HttpError) return { status: 'skipped', reason: error.message };
      deps.onUnexpectedError(error);
      return { status: 'skipped', reason: 'La demande n’a pas pu être faite pour le moment' };
    }
  };
}
