import type { Availability } from '../../shared/status.ts';

/** Progression du téléchargement en pourcentage entier ; `undefined` hors téléchargement ou sans valeur du serveur. */
export function downloadPercent({ status, progress }: Availability): number | undefined {
  if (status !== 'downloading' || progress === undefined) return undefined;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}
