import type { Availability, MediaStatus } from '../../shared/status.ts';

/** Une demande est possible tant que le titre n'est ni complet, ni en cours d'arrivée, ni déjà demandé. */
export const canRequest = (status?: MediaStatus) => !status || status === 'partial' || status === 'declined';

/** Progression du téléchargement en pourcentage entier ; `undefined` hors téléchargement ou sans valeur du serveur. */
export function downloadPercent({ status, progress }: Availability): number | undefined {
  if (status !== 'downloading' || progress === undefined) return undefined;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}
