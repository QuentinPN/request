import { z } from 'zod';

/** Rôles du plus restreint au plus puissant. */
export const roles = ['member', 'auto_approve', 'manager', 'owner'] as const;
export type Role = (typeof roles)[number];
export const roleSchema = z.enum(roles);

export const roleLabels: Record<Role, string> = {
  member: 'Membre',
  auto_approve: 'Approbation auto',
  manager: 'Gestionnaire',
  owner: 'Propriétaire',
};

/** Une phrase par rôle, pour le choisir (Réglages › Membres). */
export const roleDescriptions: Record<Role, string> = {
  member: 'Ses demandes attendent l’approbation d’un gestionnaire ; il est soumis aux quotas.',
  auto_approve: 'Ses demandes sont approuvées et envoyées sans validation ; il reste soumis aux quotas.',
  manager: 'Administre : approuve les demandes, gère signalements et blocages, hors quotas.',
  owner: 'Gère aussi les réglages et les membres. Unique, il ne se modifie pas ici.',
};

/** Rôles que le propriétaire peut attribuer : le propriétaire, lui, n'est ni attribué ni modifié depuis l'appli. */
export const assignableRoles = roles.filter((r): r is Exclude<Role, 'owner'> => r !== 'owner');
export const assignableRoleSchema = z.enum(assignableRoles);
export type AssignableRole = (typeof assignableRoles)[number];

/**
 * Droits réglables membre par membre (lot 8.4) : le rôle en donne un préréglage (`rolePermissions`), chaque membre peut
 * en remplacer certains (`users.permissions`). Libellés et ordre d'affichage : `permissionGroups`.
 */
export const permissionKeys = [
  'canRequestMovies',
  'canRequestTv',
  'canRequest4k',
  'autoApproveMovies',
  'autoApproveTv',
  'autoApprove4k',
  'canRequestOnBehalf',
  'canRequestQuotaExempt',
  'canAdvancedRequest',
  'canAutoRequestWatchlist',
  'canManageRequests',
  'canManageIssues',
  'canManageBlocklist',
  'canViewStats',
  'canManageUsers',
] as const;
export type Permission = (typeof permissionKeys)[number];

export type Capabilities = Record<Permission, boolean> & {
  /** Suit ses propres demandes (liste, fiche, annulation) : tout membre connecté, quels que soient ses droits. */
  canRequest: boolean;
  isOwner: boolean;
  /** Hors quotas de demandes, par son rôle (gestionnaire, propriétaire) : pas un droit réglable. */
  quotaExempt: boolean;
};

/** Droits que donne un rôle, avant les remplacements propres au membre. */
export function rolePermissions(role: Role): Record<Permission, boolean> {
  const rank = roles.indexOf(role);
  const autoApprove = rank >= roles.indexOf('auto_approve');
  const manager = rank >= roles.indexOf('manager');
  const owner = role === 'owner';
  return {
    canRequestMovies: true,
    canRequestTv: true,
    // Tout membre peut demander en 4K : celles d'un rôle sans approbation automatique attendent un gestionnaire.
    canRequest4k: true,
    autoApproveMovies: autoApprove,
    autoApproveTv: autoApprove,
    autoApprove4k: autoApprove,
    canRequestOnBehalf: manager,
    canRequestQuotaExempt: manager,
    canAdvancedRequest: manager,
    canAutoRequestWatchlist: owner,
    canManageRequests: manager,
    canManageIssues: manager,
    canManageBlocklist: manager,
    canViewStats: manager,
    canManageUsers: owner,
  };
}

/**
 * Remplacements propres à un membre : droit → accordé ou retiré, seulement là où il diffère du préréglage de son rôle.
 * Une clé inconnue (base éditée à la main, droit retiré) est ignorée à la lecture.
 */
export const permissionOverridesSchema = z.object(
  Object.fromEntries(permissionKeys.map((key) => [key, z.boolean().optional()])) as Record<
    Permission,
    z.ZodOptional<z.ZodBoolean>
  >,
);
export type PermissionOverrides = z.output<typeof permissionOverridesSchema>;

/** Ce que `capabilitiesOf` lit d'un membre : `permissions` est requis (`null` = préréglage du rôle seul). */
export type PermissionHolder = { role: Role; permissions: PermissionOverrides | null };

/**
 * Droits d'un membre : préréglage de son rôle, puis ses remplacements. L'unique endroit où rôle et remplacements sont
 * traduits en permissions. Le propriétaire a tout : ses remplacements sont ignorés.
 */
export function capabilitiesOf({ role, permissions }: PermissionHolder): Capabilities {
  const owner = role === 'owner';
  return {
    ...rolePermissions(role),
    ...(owner ? {} : permissions),
    canRequest: true,
    isOwner: owner,
    quotaExempt: roles.indexOf(role) >= roles.indexOf('manager'),
  };
}

/** Plafond de demandes sur une fenêtre glissante de `days` jours. */
export const quotaRuleSchema = z.object({ limit: z.number().int().min(0), days: z.number().int().min(1) });
export type QuotaRule = z.output<typeof quotaRuleSchema>;

/**
 * Quotas propres à un membre ; `null` = valeur par défaut des réglages. `unlimited` : hors quotas, quel que soit son
 * rôle (absent pour la plupart : le JSON stocké avant cette option reste valide).
 */
export const quotaOverrideSchema = z.object({
  movies: quotaRuleSchema.nullable().default(null),
  seasons: quotaRuleSchema.nullable().default(null),
  unlimited: z.literal(true).optional(),
});
export type QuotaOverride = z.output<typeof quotaOverrideSchema>;

/** Hors quotas : par son rôle (gestionnaire, propriétaire) ou par l'option « Sans quota » du membre. */
export const isQuotaExempt = (
  { quotaExempt }: Pick<Capabilities, 'quotaExempt'>,
  override: Partial<QuotaOverride> | null,
): boolean => quotaExempt || override?.unlimited === true;

// --- Droits fins (lot 8.4) ---

/** Droits effectifs (préréglage + remplacements), clé par clé. */
export function effectivePermissions(holder: PermissionHolder): Record<Permission, boolean> {
  const capabilities = capabilitiesOf(holder);
  return Object.fromEntries(permissionKeys.map((key) => [key, capabilities[key]])) as Record<Permission, boolean>;
}

/** Ce qui diffère du préréglage de `role`, `null` si rien : la seule forme enregistrée en base. */
export function permissionOverridesOf(
  role: Role,
  wanted: Partial<Record<Permission, boolean>>,
): PermissionOverrides | null {
  const preset = rolePermissions(role);
  const diff: PermissionOverrides = {};
  for (const key of permissionKeys) {
    const value = wanted[key];
    if (value !== undefined && value !== preset[key]) diff[key] = value;
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

export type PermissionInfo = { key: Permission; label: string; hint: string };

/** Libellés et explications, groupés comme dans Réglages › Membres. */
export const permissionGroups: ReadonlyArray<{ label: string; permissions: readonly PermissionInfo[] }> = [
  {
    label: 'Demandes',
    permissions: [
      { key: 'canRequestMovies', label: 'Demander des films', hint: 'Propose « Demander » sur les films.' },
      { key: 'canRequestTv', label: 'Demander des séries', hint: 'Propose « Demander » sur les séries.' },
      {
        key: 'canRequest4k',
        label: 'Demander en 4K',
        hint: 'Pour les types qu’il peut demander, si un serveur 4K du type existe.',
      },
      {
        key: 'autoApproveMovies',
        label: 'Approbation automatique des films',
        hint: 'Ses demandes de films partent sans validation.',
      },
      {
        key: 'autoApproveTv',
        label: 'Approbation automatique des séries',
        hint: 'Ses demandes de séries partent sans validation.',
      },
      {
        key: 'autoApprove4k',
        label: 'Approbation automatique des demandes 4K',
        hint: 'Ses demandes 4K partent sans validation.',
      },
      {
        key: 'canRequestOnBehalf',
        label: 'Demander pour un autre membre',
        hint: 'La demande est au membre choisi : son quota et ses droits s’appliquent.',
      },
      {
        key: 'canRequestQuotaExempt',
        label: 'Demander hors quota',
        hint: 'Case « Hors quota » au cas par cas, dans la feuille de demande.',
      },
      {
        key: 'canAdvancedRequest',
        label: 'Demande avancée',
        hint: 'Choisir le serveur, le profil et le dossier de sa demande.',
      },
      {
        key: 'canAutoRequestWatchlist',
        label: 'Demande automatique depuis Ma liste',
        hint: 'Les titres ajoutés à Ma liste sont demandés pour lui.',
      },
    ],
  },
  {
    label: 'Gestion',
    permissions: [
      {
        key: 'canManageRequests',
        label: 'Gérer les demandes',
        hint: 'Voit toutes les demandes, les approuve, les refuse et les relance.',
      },
      {
        key: 'canManageIssues',
        label: 'Gérer les signalements',
        hint: 'Voit tous les signalements, les commente et les résout.',
      },
      { key: 'canManageBlocklist', label: 'Gérer les blocages', hint: 'Bloque des titres et des mots-clés.' },
      { key: 'canViewStats', label: 'Voir les statistiques', hint: 'Ouvre la page Statistiques.' },
      {
        key: 'canManageUsers',
        label: 'Gérer les membres',
        hint: 'Rôles, droits et quotas des membres qui ne gèrent pas les membres.',
      },
    ],
  },
];

const permissionLabel = (key: Permission) =>
  permissionGroups.flatMap((g) => g.permissions).find((p) => p.key === key)?.label ?? key;

type RequestKind = { type: 'movie' | 'tv'; is4k: boolean };

/**
 * Refus d'une demande de ce type et de cette qualité d'après les droits du membre à qui elle sera, `null` si permise.
 * Une demande 4K suppose aussi le droit de demander ce type. Même règle pour le serveur (403) et le bouton « Demander ».
 */
export function requestRefusal(
  capabilities: Pick<Capabilities, 'canRequestMovies' | 'canRequestTv' | 'canRequest4k'>,
  { type, is4k }: RequestKind,
): string | null {
  if (type === 'movie' && !capabilities.canRequestMovies) return 'Pas de droit de demander des films';
  if (type === 'tv' && !capabilities.canRequestTv) return 'Pas de droit de demander des séries';
  if (is4k && !capabilities.canRequest4k) return 'Pas de droit de demander en 4K';
  return null;
}

/** La demande est approuvée sans validation : en 4K, par « approbation automatique 4K » ; sinon, celle de son type. */
export const autoApproves = (
  capabilities: Pick<Capabilities, 'autoApproveMovies' | 'autoApproveTv' | 'autoApprove4k'>,
  { type, is4k }: RequestKind,
): boolean =>
  is4k ? capabilities.autoApprove4k : type === 'movie' ? capabilities.autoApproveMovies : capabilities.autoApproveTv;

/**
 * Garde contre l'escalade : refus (message en français) de la modification de `target` en `next` par `actor`, ou `null`.
 * Le propriétaire modifie tout membre sauf lui-même. Un autre membre qui gère les membres ne modifie ni un membre qui
 * gère les membres (lui compris), n'accorde que des droits qu'il a, jamais « Gérer les membres », et n'attribue le rôle
 * Gestionnaire que s'il a tous ses droits et qu'il est hors quota. Retirer un droit, même qu'il n'a pas, reste permis ;
 * les quotas, eux, ont leur garde (`quotaEditRefusal`).
 * Droits comparés effectifs, avant et après : un changement de rôle compte comme une attribution.
 */
export function memberEditRefusal(
  actor: Capabilities,
  target: PermissionHolder,
  next: PermissionHolder,
): string | null {
  if (target.role === 'owner') return 'Le propriétaire ne se modifie pas depuis l’appli';
  if (actor.isOwner) return null;
  if (!actor.canManageUsers) return 'Accès refusé';
  const before = effectivePermissions(target);
  if (before.canManageUsers) return 'Seul le propriétaire modifie un membre qui gère les membres';
  if (next.role === 'manager' && target.role !== 'manager' && !canAssignManager(actor)) return MANAGER_ASSIGN_REFUSAL;
  const after = effectivePermissions(next);
  const granted = permissionKeys.filter((key) => after[key] && !before[key]);
  if (granted.includes('canManageUsers')) return 'Seul le propriétaire peut accorder « Gérer les membres »';
  const missing = granted.find((key) => !canGrant(actor, key));
  return missing ? `Vous ne pouvez pas accorder un droit que vous n’avez pas : ${permissionLabel(missing)}` : null;
}

/**
 * Refus (message en français) de la suppression de `target` par `actor` (dont l'id est `actorId`), ou `null` : ni le
 * propriétaire ni soi-même, puis la garde contre l'escalade d'une modification sans changement (`memberEditRefusal`) :
 * on supprime qui l'on peut modifier. Même règle pour le serveur (403) et le bouton « Supprimer ce membre ».
 */
export function memberDeleteRefusal(
  actor: Capabilities,
  actorId: string | undefined,
  target: PermissionHolder & { id: string },
): string | null {
  if (target.role === 'owner') return 'Le propriétaire ne se supprime pas depuis l’appli';
  if (target.id === actorId) return 'Vous ne pouvez pas supprimer votre propre compte';
  return memberEditRefusal(actor, target, target);
}

/** Ce que `actor` peut accorder (case modifiable), pour l'interface : la garde serveur reste `memberEditRefusal`. */
export const canGrant = (actor: Capabilities, key: Permission): boolean =>
  actor.isOwner || (actor[key] && key !== 'canManageUsers');

export const MANAGER_ASSIGN_REFUSAL =
  'Seul un membre qui a tous les droits d’un gestionnaire et qui est hors quota peut attribuer ce rôle';

/** `actor` peut attribuer le rôle Gestionnaire (voir `memberEditRefusal`). */
export const canAssignManager = (actor: Capabilities): boolean =>
  actor.isOwner || (actor.quotaExempt && permissionKeys.every((key) => !rolePermissions('manager')[key] || actor[key]));

/** Refus du réglage des quotas d'un membre (sans quota compris) par `actor`, ou `null` : hors quota lui-même, sinon un membre pourrait se libérer des quotas par un autre. */
export const quotaEditRefusal = (actor: Capabilities): string | null =>
  actor.isOwner || actor.quotaExempt ? null : 'Seul un membre hors quota peut régler les quotas d’un membre';
