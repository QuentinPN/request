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

export type Capabilities = {
  canRequest: boolean;
  /** Ses demandes sont approuvées sans validation. */
  autoApprove: boolean;
  /** Peut approuver, refuser et voir toutes les demandes. */
  canManageRequests: boolean;
  /** Peut changer les rôles et les quotas des membres. */
  canManageUsers: boolean;
  isOwner: boolean;
  /** Hors quotas de demandes. */
  quotaExempt: boolean;
  /** Peut demander en 4K (bouton visible seulement si un serveur 4K du bon type existe). */
  canRequest4k: boolean;
  /** Ses demandes 4K sont approuvées sans validation. */
  autoApprove4k: boolean;
  /** Voit tous les signalements, les commente, les résout et les rouvre. */
  canManageIssues: boolean;
  /** Peut demander un titre à la place d'un membre (quota et notifications du membre). */
  canRequestOnBehalf: boolean;
  /** Peut bloquer des titres et des mots-clés. */
  canManageBlocklist: boolean;
  /** Voit la page Statistiques. */
  canViewStats: boolean;
};

/** Droits dérivés du rôle : l'unique endroit où le rôle est traduit en permissions. */
export function capabilitiesOf(role: Role): Capabilities {
  const rank = roles.indexOf(role);
  const autoApprove = rank >= roles.indexOf('auto_approve');
  const manager = rank >= roles.indexOf('manager');
  return {
    canRequest: true,
    autoApprove,
    canManageRequests: manager,
    canManageUsers: role === 'owner',
    isOwner: role === 'owner',
    quotaExempt: manager,
    // Tout membre peut demander en 4K : celles d'un rôle sans approbation automatique attendent un gestionnaire.
    canRequest4k: true,
    autoApprove4k: autoApprove,
    canManageIssues: manager,
    canRequestOnBehalf: manager,
    canManageBlocklist: manager,
    canViewStats: manager,
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
