import { STATS_PATH, type StatsDelay, statsSchema } from '@shared/stats.ts';
import { queryOptions } from '@tanstack/react-query';
import { apiGet } from './http.ts';

/** Statistiques de la page « Statistiques » (gestionnaires et propriétaire), calculées par le serveur. */
export const statsQuery = () =>
  queryOptions({
    queryKey: ['stats'] as const,
    queryFn: ({ signal }) => apiGet(STATS_PATH, statsSchema, signal),
  });

const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
export const formatCount = (n: number) => new Intl.NumberFormat('fr-FR').format(n);

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Durée lisible d'un délai : minutes, heures jusqu'à deux jours, puis jours. */
export function formatDelay(seconds: number): string {
  if (seconds < MINUTE) return 'moins d’une minute';
  if (seconds < HOUR) return `${Math.round(seconds / MINUTE)} min`;
  if (seconds < 2 * DAY) return `${decimal.format(seconds / HOUR)} h`;
  return `${decimal.format(seconds / DAY)} j`;
}

/** « Médiane 2 h · moyenne 3 h », ou le texte de repli tant qu'aucune demande n'a passé l'étape. */
export function delaySummary({ samples, medianSeconds, meanSeconds }: StatsDelay) {
  if (samples === 0 || medianSeconds === null || meanSeconds === null)
    return { value: '—', detail: 'Pas encore de mesure' };
  return {
    value: formatDelay(medianSeconds),
    detail: `Moyenne ${formatDelay(meanSeconds)} · ${formatCount(samples)} ${samples > 1 ? 'demandes' : 'demande'}`,
  };
}

/** `2026-03` : nom du mois (UTC, comme le calcul du serveur), court ou une lettre. */
export const monthName = (month: string, style: 'long' | 'short' | 'narrow') =>
  new Intl.DateTimeFormat('fr-FR', {
    month: style,
    timeZone: 'UTC',
    ...(style === 'long' && { year: 'numeric' }),
  }).format(new Date(`${month}-01T00:00:00Z`));

/** Part de `value` dans `total`, en pourcentage entier (0 sans total). */
export const percentOf = (value: number, total: number) => (total === 0 ? 0 : Math.round((value / total) * 100));
