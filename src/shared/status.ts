/** Disponibilité d'un titre, calculée côté serveur (Emby + Radarr/Sonarr + demandes). */
export const mediaStatuses = ['available', 'partial', 'downloading', 'requested', 'pending', 'declined'] as const;
export type MediaStatus = (typeof mediaStatuses)[number];

export const mediaStatusLabel: Record<MediaStatus, string> = {
  available: 'Disponible',
  partial: 'Partiel',
  downloading: 'En téléchargement',
  requested: 'Demandé',
  pending: 'En attente',
  declined: 'Refusé',
};

/** Libellé court pour les affiches, où la place manque sur mobile. */
export const mediaStatusShortLabel: Record<MediaStatus, string> = { ...mediaStatusLabel, downloading: 'En cours' };
