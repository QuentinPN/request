import { z } from 'zod';
import { mediaTypeSchema } from './media.ts';
import { requestStatusSchema } from './status.ts';

/** Page Statistiques (réservée au droit `canViewStats`) : un seul endpoint, calculé en SQL par le serveur. */
export const STATS_PATH = '/api/stats';

/** Mois glissants de l'histogramme : le mois courant et les 11 précédents (UTC). */
export const STATS_MONTHS = 12;
/** Longueur des classements (membres, titres). */
export const STATS_TOP = 10;

const count = z.number().int().min(0);

/** Délai écoulé depuis la demande, en secondes ; `null` tant qu'aucune demande n'a passé l'étape. */
const delaySchema = z.object({
  samples: count,
  medianSeconds: z.number().min(0).nullable(),
  meanSeconds: z.number().min(0).nullable(),
});
export type StatsDelay = z.infer<typeof delaySchema>;

export const statsSchema = z.object({
  requests: z.object({
    total: count,
    /** Tous les statuts sont présents, à 0 s'il n'y a aucune demande. */
    byStatus: z.record(requestStatusSchema, count),
    /** `month` : `AAAA-MM` (UTC), les 12 mois glissants, mois vides compris, du plus ancien au plus récent. */
    byMonth: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), count })).length(STATS_MONTHS),
    byType: z.record(mediaTypeSchema, count),
    byQuality: z.object({ standard: count, fourK: count }),
  }),
  topMembers: z
    .array(z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable(), count }))
    .max(STATS_TOP),
  /** `title`, `year` et `posterPath` : ceux de TMDB s'ils sont connus (TMDB non configuré ou en panne : `null`). */
  topTitles: z
    .array(
      z.object({
        type: mediaTypeSchema,
        tmdbId: z.number().int(),
        title: z.string().nullable(),
        year: z.number().int().nullable(),
        posterPath: z.string().nullable(),
        count,
      }),
    )
    .max(STATS_TOP),
  delays: z.object({ approval: delaySchema, availability: delaySchema }),
  issues: z.object({ open: count, resolved: count }),
  members: count,
  watchlist: z.object({ entries: count, titles: count }),
});
export type Stats = z.infer<typeof statsSchema>;
