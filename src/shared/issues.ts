import { z } from 'zod';
import { mediaTypeSchema } from './media.ts';

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
    seasonNumber: z.number().int().nonnegative().nullable().default(null),
    episodeNumber: z.number().int().positive().nullable().default(null),
    message,
  })
  .refine((i) => i.episodeNumber === null || i.seasonNumber !== null, {
    message: 'Saison requise pour un épisode',
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
