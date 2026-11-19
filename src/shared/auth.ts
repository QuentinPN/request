import { z } from 'zod';
import {
  assignableRoleSchema,
  type Capabilities,
  type PermissionOverrides,
  permissionKeys,
  permissionOverridesSchema,
  type QuotaOverride,
  quotaOverrideSchema,
  type Role,
} from './roles.ts';

/**
 * Protection CSRF : toute requête d'écriture vers `/api` porte cet en-tête (valeur `1`).
 * Un formulaire d'un autre site ne peut pas l'ajouter sans déclencher un pré-vol CORS, que l'appli refuse.
 */
export const CSRF_HEADER = 'x-request';
export const CSRF_VALUE = '1';
/** À joindre à chaque `fetch` d'écriture du client. */
export const CSRF_HEADERS: Readonly<Record<string, string>> = { [CSRF_HEADER]: CSRF_VALUE };

export const LOGIN_PATH = '/api/auth/login';
export const LOGOUT_PATH = '/api/auth/logout';
export const VIEWER_PATH = '/api/auth/me';

export const USERS_PATH = '/api/users';
export const USERS_IMPORT_PATH = `${USERS_PATH}/import`;
/** Modification de plusieurs membres en une fois (rôle et droits, une transaction). */
export const USERS_BULK_PATH = `${USERS_PATH}/bulk`;
/** « Droits par défaut » des nouveaux membres (propriétaire). */
export const USERS_DEFAULTS_PATH = `${USERS_PATH}/defaults`;
/** Un membre (id déjà encodé pour une adresse), sa photo relayée ou ses sessions. */
export const userPath = (id: string, part?: 'avatar' | 'sessions') => `${USERS_PATH}/${id}${part ? `/${part}` : ''}`;

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

/** Droits de demande d'un membre : ce qu'il faut pour demander à sa place sans voir le reste de ses droits. */
export const memberRequestKeys = [
  'canRequestMovies',
  'canRequestTv',
  'canRequest4k',
  'autoApproveMovies',
  'autoApproveTv',
  'autoApprove4k',
] as const;

/** Membre tel que le voit qui ne gère pas les membres (sélecteurs) : identité et droits de demande, rien d'autre. */
export const memberOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  ...(Object.fromEntries(memberRequestKeys.map((key) => [key, z.boolean()])) as Record<
    (typeof memberRequestKeys)[number],
    z.ZodBoolean
  >),
});
export type MemberOption = z.output<typeof memberOptionSchema>;

/** Un membre dans la liste de gestion (`GET /api/users` : réservée à qui gère les membres, les autres reçoivent `MemberOption`). */
export interface Member extends MemberOption {
  role: Role;
  quotaOverride: QuotaOverride | null;
  /** Remplacements des droits du rôle, `null` = préréglage du rôle seul (droits effectifs : `capabilitiesOf(member)`). */
  permissions: PermissionOverrides | null;
  /** ISO 8601, `null` pour un membre importé qui ne s'est jamais connecté. */
  lastLoginAt: string | null;
}

export const memberUpdateSchema = z.object({
  /** Jamais `owner` : le propriétaire n'est ni attribué ni modifié depuis l'appli. */
  role: assignableRoleSchema.optional(),
  /** `null` : revenir aux quotas par défaut. */
  quotaOverride: quotaOverrideSchema.nullable().optional(),
  /**
   * Remplacements des droits, écart au préréglage du rôle final (`null` : revenir au rôle). Absent : un rôle donné
   * applique son préréglage (remplacements effacés) ; sans rôle, ils restent.
   */
  permissions: permissionOverridesSchema.nullable().optional(),
});
export type MemberUpdate = z.input<typeof memberUpdateSchema>;

export const membersBulkUpdateSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1, 'Aucun membre choisi').max(500),
    /** Rôle appliqué à tous : son préréglage remplace leurs droits propres, avant les changements de `permissions`. */
    role: assignableRoleSchema.optional(),
    /** Droit à changer pour toute la sélection : accordé (`true`) ou retiré (`false`) ; absent = inchangé. */
    permissions: permissionOverridesSchema.default({}),
  })
  .refine((u) => u.role !== undefined || permissionKeys.some((k) => u.permissions[k] !== undefined), {
    message: 'Rien à changer',
  });
export type MembersBulkUpdate = z.input<typeof membersBulkUpdateSchema>;
