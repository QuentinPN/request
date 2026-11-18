import { z } from 'zod';
import { type Capabilities, type QuotaOverride, quotaOverrideSchema, type Role, roleSchema } from './roles.ts';

/**
 * Protection CSRF : toute requête d'écriture vers `/api` porte cet en-tête (valeur `1`).
 * Un formulaire d'un autre site ne peut pas l'ajouter sans déclencher un pré-vol CORS, que l'appli refuse.
 */
export const CSRF_HEADER = 'x-request';
export const CSRF_VALUE = '1';
/** À joindre à chaque `fetch` d'écriture du client. */
export const CSRF_HEADERS: Readonly<Record<string, string>> = { [CSRF_HEADER]: CSRF_VALUE };

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Identifiant requis'),
  // Emby accepte les comptes sans mot de passe.
  password: z.string(),
});
export type LoginInput = z.input<typeof loginSchema>;

/** Le membre connecté, tel que le navigateur le voit. */
export interface Viewer {
  id: string;
  name: string;
  role: Role;
  capabilities: Capabilities;
  /** Adresse relative à l'appli (relais de l'image Emby), `null` sans photo. */
  avatarUrl: string | null;
}

/** Un membre dans la liste de gestion. */
export interface Member {
  id: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
  quotaOverride: QuotaOverride | null;
  /** ISO 8601, `null` pour un membre importé qui ne s'est jamais connecté. */
  lastLoginAt: string | null;
}

export const memberUpdateSchema = z.object({
  role: roleSchema.optional(),
  /** `null` : revenir aux quotas par défaut. */
  quotaOverride: quotaOverrideSchema.nullable().optional(),
});
