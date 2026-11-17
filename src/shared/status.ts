import { z } from 'zod';

/** Disponibilité d'un titre, calculée côté serveur (Emby + Radarr/Sonarr + demandes). */
export const mediaStatuses = ['available', 'partial', 'downloading', 'requested', 'pending', 'declined'] as const;
export type MediaStatus = (typeof mediaStatuses)[number];
export const mediaStatusSchema = z.enum(mediaStatuses);

/** Part du statut lue dans la bibliothèque (Emby, Radarr, Sonarr) ; le reste vient des demandes. */
export type LibraryStatus = Extract<MediaStatus, 'available' | 'partial' | 'downloading'>;

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

/**
 * Cycle de vie d'une demande. `cancelled` : annulée par le membre (historique conservé, hors quota) ;
 * `available` : arrivée dans Emby.
 */
export const requestStatuses = ['pending', 'approved', 'declined', 'cancelled', 'sent', 'failed', 'available'] as const;
export type RequestStatus = (typeof requestStatuses)[number];
export const requestStatusSchema = z.enum(requestStatuses);

/**
 * Demandes « en cours » : une seule par membre et par titre (index `requests_active`), elles couvrent leurs saisons,
 * comptent dans les compteurs et font afficher « Demandé ». `failed` en fait partie : la relance la reprend.
 */
export const activeRequestStatuses = [
  'pending',
  'approved',
  'sent',
  'failed',
] as const satisfies readonly RequestStatus[];
export type ActiveRequestStatus = (typeof activeRequestStatuses)[number];

/**
 * États d'avant l'envoi : l'index `requests_active` n'en couvre pas d'autres, une demande `sent` ne bloque donc pas
 * une nouvelle demande du même membre (saisons suivantes d'une série).
 */
export const preSendRequestStatuses = [
  'pending',
  'approved',
  'failed',
] as const satisfies readonly ActiveRequestStatus[];

/**
 * Faits de la frise d'une demande (`request_events`, ajout seulement) : `retried` marque la relance d'un envoi en
 * échec, suivie d'un nouveau `sent` ou `failed` ; `available` sera posé par la synchronisation (5.1).
 */
export const requestEventTypes = [
  'requested',
  'approved',
  'declined',
  'cancelled',
  'sent',
  'failed',
  'retried',
  'available',
] as const;
export type RequestEventType = (typeof requestEventTypes)[number];

/**
 * Statut affiché d'un titre ou d'une saison : absent du champ `status` = rien dans la bibliothèque ni en demande.
 * `progress` (0 à 1) accompagne `downloading`.
 */
export const availabilitySchema = z.object({
  status: mediaStatusSchema.optional(),
  progress: z.number().min(0).max(1).optional(),
});
export type Availability = z.infer<typeof availabilitySchema>;
