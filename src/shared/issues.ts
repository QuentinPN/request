import { z } from 'zod';
import { mediaTypeSchema, pagedSchema } from './media.ts';

/** Nature d'un problème signalé sur un titre disponible. */
export const issueTypes = ['video', 'audio', 'subtitles', 'other'] as const;
export type IssueType = (typeof issueTypes)[number];
export const issueTypeSchema = z.enum(issueTypes);

export const issueTypeLabels: Record<IssueType, string> = {
  video: 'Vidéo',
  audio: 'Audio',
  subtitles: 'Sous-titres',
  other: 'Autre',
};

/** Un signalement résolu peut être rouvert. */
export const issueStatuses = ['open', 'resolved'] as const;
export type IssueStatus = (typeof issueStatuses)[number];
export const issueStatusSchema = z.enum(issueStatuses);

export const issueStatusLabels: Record<IssueStatus, string> = { open: 'Ouvert', resolved: 'Résolu' };

export const ISSUE_MESSAGE_MAX = 2000;
const message = z.string().trim().min(1, 'Message requis').max(ISSUE_MESSAGE_MAX);

// --- Entrées ---

/** Nouveau signalement : saison et épisode facultatifs (séries), un épisode suppose sa saison. */
export const issueCreateSchema = z
  .object({
    type: issueTypeSchema,
    mediaType: mediaTypeSchema,
    tmdbId: z.number().int().positive(),
    seasonNumber: z.number().int().nonnegative().max(100).nullable().default(null),
    episodeNumber: z.number().int().positive().max(1000).nullable().default(null),
    message,
  })
  .refine((i) => i.episodeNumber === null || i.seasonNumber !== null, {
    message: 'Saison requise pour un épisode',
    path: ['seasonNumber'],
  })
  .refine((i) => i.mediaType === 'tv' || (i.seasonNumber === null && i.episodeNumber === null), {
    message: 'Saison et épisode : séries seulement',
    path: ['seasonNumber'],
  });
export type IssueCreateInput = z.input<typeof issueCreateSchema>;

export const issueCommentInputSchema = z.object({ message });
export type IssueCommentInput = z.input<typeof issueCommentInputSchema>;

// --- Réponses ---

/** Auteur d'un signalement ou d'un commentaire ; `null` si le membre n'existe plus. */
export const issueAuthorSchema = z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable() });
export type IssueAuthor = z.output<typeof issueAuthorSchema>;

export const issueCommentSchema = z.object({
  id: z.number().int(),
  issueId: z.number().int(),
  author: issueAuthorSchema.nullable(),
  message: z.string(),
  createdAt: z.string(),
});
export type IssueComment = z.output<typeof issueCommentSchema>;

export const issueSchema = z.object({
  id: z.number().int(),
  type: issueTypeSchema,
  status: issueStatusSchema,
  media: z.object({ type: mediaTypeSchema, tmdbId: z.number().int() }),
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  message: z.string(),
  author: issueAuthorSchema.nullable(),
  resolvedBy: issueAuthorSchema.nullable(),
  /** Dates ISO 8601 ; `resolvedAt` : `null` tant que le signalement est ouvert. */
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Issue = z.output<typeof issueSchema>;

// --- Listes et détail ---

export const ISSUES_PAGE_SIZE = 20;

export const issueListQuerySchema = z.object({
  status: issueStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
});
export type IssueListQuery = z.input<typeof issueListQuerySchema>;

export const issueIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** Signalement avec le titre du média (résumé TMDB, `null` si TMDB est en panne). */
export const issueViewSchema = issueSchema.extend({
  title: z.string().nullable(),
  posterPath: z.string().nullable(),
});
export type IssueView = z.output<typeof issueViewSchema>;

export const issueDetailSchema = issueViewSchema.extend({ comments: z.array(issueCommentSchema) });
export type IssueDetail = z.output<typeof issueDetailSchema>;

/** Une page de signalements ; `totals` compte chaque statut du périmètre du membre (les siens, ou tous). */
export const issuePageSchema = pagedSchema(issueViewSchema).extend({
  totals: z.object({ open: z.number().int(), resolved: z.number().int() }),
});
export type IssuePage = z.output<typeof issuePageSchema>;

/** Signalements ouverts du périmètre du membre (pastille de la navigation). */
export interface IssueCounts {
  open: number;
}
