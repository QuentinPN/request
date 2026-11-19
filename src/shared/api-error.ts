import { z } from 'zod';

/** Corps de toute réponse d'erreur de l'API : un message court, lisible, en français. */
export const apiErrorSchema = z.object({ error: z.string() });
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
