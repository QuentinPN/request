import type { ArrKind } from '@shared/arr-servers.ts';
import type { AgentEventKind, NotificationKind } from '@shared/notifications.ts';
import {
  type IntegrationKey,
  type MediaServerKind,
  mediaServerKindLabels,
  type minimumAvailabilities,
  type seriesTypes,
  type smtpSecurities,
} from '@shared/settings.ts';
import type { ArrTestResult, SetupSection, TestResults } from '@shared/setup.ts';
import { plural } from '@shared/text.ts';

/**
 * Ordre des sections à l'écran (DESIGN.md, maquette R-Assistant) : serveur multimédia (Emby, Jellyfin ou Plex), TMDB,
 * Radarr, Sonarr, Règles.
 */
export const sectionOrder = [
  'mediaServer',
  'tmdb',
  'radarr',
  'sonarr',
  'rules',
] as const satisfies readonly SetupSection[];
// Toute section du contrat partagé doit apparaître ici.
const _complete: Exclude<SetupSection, (typeof sectionOrder)[number]> extends never ? true : never = true;
void _complete;

/**
 * Sections de Réglages : celles de l'assistant, plus les membres, les webhooks, Discord, le courriel, Trakt, l'import facultatif des
 * demandes de Seerr et les clés d'API (propriétaire, hors assistant : rien à tester ou facultatif).
 */
export type SectionId =
  | SetupSection
  | 'members'
  | 'webhooks'
  | 'seerr'
  | 'discord'
  | 'ntfy'
  | 'telegram'
  | 'outgoingWebhook'
  | 'smtp'
  | 'trakt'
  | 'api'
  | 'blocklist'
  | 'jobs'
  | 'cache'
  | 'logs'
  | 'general'
  | 'about'
  | 'discover'
  | 'overrideRules';
export const settingsSectionOrder = [
  ...sectionOrder,
  'members',
  'webhooks',
  'seerr',
  'discord',
  'ntfy',
  'telegram',
  'outgoingWebhook',
  'smtp',
  'trakt',
  'api',
  'blocklist',
  'jobs',
  'cache',
  'logs',
  'general',
  'about',
  'discover',
  'overrideRules',
] as const satisfies readonly SectionId[];

const ISSUE_OPENED_LABEL = 'Nouveau signalement';

/**
 * Libellé de chaque type de notification, seule liste : évènements des agents (dans l'ordre de la frise d'une demande)
 * et types du courriel (au nom du serveur multimédia choisi).
 */
export const eventLabels = (serverName: string): Record<NotificationKind | AgentEventKind, string> => ({
  requested: 'Nouvelle demande à approuver',
  approved: 'Demande approuvée',
  auto_approved: 'Demande approuvée automatiquement',
  declined: 'Demande refusée',
  cancelled: 'Demande annulée',
  available: `Titre disponible dans ${serverName}`,
  failed: 'Échec de l’envoi à Radarr ou Sonarr',
  requested_on_behalf: 'Demande faite à la place du membre',
  issue_created: ISSUE_OPENED_LABEL,
  issue_opened: ISSUE_OPENED_LABEL,
  issue_commented: 'Signalement commenté',
  issue_resolved: 'Signalement résolu',
  issue_reopened: 'Signalement rouvert',
});

export const sectionText: Record<SectionId, { title: string; description: string }> = {
  mediaServer: {
    title: 'Serveur multimédia',
    description: 'Emby, Jellyfin ou Plex : connexion des membres et détection de ce qui est déjà là',
  },
  tmdb: { title: 'TMDB', description: 'Catalogue, affiches et tendances en français' },
  radarr: { title: 'Radarr', description: 'Films : serveurs, profil de qualité et dossier racine' },
  sonarr: { title: 'Sonarr', description: 'Séries : serveurs, profil de qualité, dossier racine et type' },
  rules: { title: 'Règles et quotas', description: 'Quotas de demandes par défaut des membres' },
  members: { title: 'Membres', description: 'Rôles, droits et quotas des membres' },
  webhooks: { title: 'Webhooks', description: 'Radarr et Sonarr préviennent l’appli dès qu’un titre arrive' },
  seerr: { title: 'Importer depuis Seerr', description: 'Reprendre une fois les demandes de Jellyseerr ou Overseerr' },
  discord: {
    title: 'Notifications Discord',
    description: 'Facultatif : les évènements des demandes et des signalements dans un salon',
  },
  ntfy: {
    title: 'Notifications ntfy',
    description: 'Facultatif : les évènements des demandes et des signalements sur un sujet ntfy',
  },
  telegram: {
    title: 'Notifications Telegram',
    description: 'Facultatif : les évènements des demandes et des signalements par un bot',
  },
  outgoingWebhook: {
    title: 'Webhook sortant',
    description: 'Facultatif : un POST JSON à chaque évènement, pour vos propres outils',
  },
  smtp: { title: 'Notifications par courriel', description: 'Facultatif : serveur SMTP pour écrire aux membres' },
  trakt: { title: 'Listes externes', description: 'Facultatif : import des listes de souhaits Trakt des membres' },
  api: { title: 'API', description: 'Clés pour les scripts et outils externes (en-tête X-Api-Key)' },
  blocklist: { title: 'Blocages', description: 'Titres et mots-clés TMDB qui ne peuvent pas être demandés' },
  discover: { title: 'Découvrir', description: 'Rangées de la page, langue et région de TMDB' },
  jobs: { title: 'Tâches', description: 'Balayages et sauvegarde : dernière exécution, fréquence, lancement immédiat' },
  cache: { title: 'Cache d’images', description: 'Poids des affiches enregistrées sur le disque, et vidage' },
  logs: { title: 'Journaux', description: 'Dernières entrées du serveur, filtrables, sans secret' },
  general: { title: 'Général', description: 'Titre de l’application, affiché dans l’onglet et les messages' },
  about: { title: 'À propos', description: 'Version, environnement et compteurs, en lecture seule' },
  overrideRules: {
    title: 'Règles de surcharge',
    description: 'Serveur, profil, dossier et étiquettes selon le genre, la langue ou les mots-clés d’un titre',
  },
};

/** Service qui se teste à la connexion : une intégration (réglage) ou un serveur Radarr/Sonarr. */
export type ConnectionKey = IntegrationKey | ArrKind;

type ConnectionText = { url: { placeholder: string } | null; apiKeyLabel: string; apiKeyHint: string };

/** Champs de connexion de chaque type de serveur multimédia. */
const mediaServerText: Record<MediaServerKind, ConnectionText> = {
  emby: {
    url: { placeholder: 'http://192.0.2.20:8096' },
    apiKeyLabel: 'Clé d’API',
    apiKeyHint: 'Emby › Tableau de bord › Avancé › Clés d’API',
  },
  jellyfin: {
    url: { placeholder: 'http://192.0.2.20:8096' },
    apiKeyLabel: 'Clé d’API',
    apiKeyHint: 'Jellyfin › Tableau de bord › Clés API',
  },
  plex: {
    url: { placeholder: 'http://192.0.2.20:32400' },
    apiKeyLabel: 'Jeton Plex du propriétaire',
    apiKeyHint: 'Plex Web › un titre › ⋯ › Infos multimédia › Afficher le XML : valeur de X-Plex-Token dans l’adresse',
  },
};

const connectionText: Record<Exclude<ConnectionKey, 'mediaServer'>, ConnectionText> = {
  tmdb: {
    url: null,
    apiKeyLabel: 'Clé d’API ou jeton de lecture',
    apiKeyHint: 'themoviedb.org › Paramètres › API (clé v3 ou jeton v4)',
  },
  radarr: {
    url: { placeholder: 'http://192.0.2.20:7878' },
    apiKeyLabel: 'Clé d’API',
    apiKeyHint: 'Radarr › Paramètres › Général',
  },
  sonarr: {
    url: { placeholder: 'http://192.0.2.20:8989' },
    apiKeyLabel: 'Clé d’API',
    apiKeyHint: 'Sonarr › Paramètres › Général',
  },
};

/** Champs de connexion de chaque service ; `url: null` = clé seule (TMDB). Le serveur multimédia dépend de son type. */
export const connectionTextOf = (key: ConnectionKey, kind: MediaServerKind | null): ConnectionText =>
  key === 'mediaServer' ? mediaServerText[kind ?? 'emby'] : connectionText[key];

/** Adresse saisie d'un service (vérification locale, avant l'appel au serveur). */
export const isHttpUrl = (value: string) => /^https?:\/\/[^\s/]+/i.test(value.trim());
export const URL_ERROR = 'Adresse invalide : elle doit commencer par http:// ou https://';

export const minimumAvailabilityLabels: Record<(typeof minimumAvailabilities)[number], string> = {
  announced: 'Annoncé',
  inCinemas: 'Au cinéma',
  released: 'Sorti',
};

export const seriesTypeLabels: Record<(typeof seriesTypes)[number], string> = {
  standard: 'Standard',
  anime: 'Anime',
  daily: 'Quotidienne',
};

/** Sécurité SMTP et son port habituel, repris quand le propriétaire change de sécurité sans avoir changé le port. */
export const smtpSecurityOptions: Record<(typeof smtpSecurities)[number], { label: string; port: number }> = {
  starttls: { label: 'STARTTLS (port 587)', port: 587 },
  tls: { label: 'TLS (port 465)', port: 465 },
  none: { label: 'Aucune (port 25, réseau local seulement)', port: 25 },
};

export const libraryTypeLabels = { movies: 'Films', tvshows: 'Séries', other: 'Autre' } as const;

const arrSummary = (name: string, r: ArrTestResult) =>
  `${name} v${r.version} · ${plural(r.qualityProfiles.length, 'profil', 'profils')}, ${plural(r.rootFolders.length, 'dossier', 'dossiers')}`;

/** Ligne affichée après un test réussi : « Connexion réussie · Sonarr v4.0.11 · 3 profils, 2 dossiers ». */
export function testSummary<K extends ConnectionKey>(
  key: K,
  result: TestResults[K],
  kind: MediaServerKind | null,
): string {
  const detail = {
    mediaServer: () => {
      const r = result as TestResults['mediaServer'];
      const name = mediaServerKindLabels[kind ?? 'emby'];
      return `${r.serverName} · ${name} v${r.version} · ${plural(r.libraries.length, 'bibliothèque', 'bibliothèques')}`;
    },
    tmdb: () => 'TMDB',
    radarr: () => arrSummary('Radarr', result as TestResults['radarr']),
    sonarr: () => arrSummary('Sonarr', result as TestResults['sonarr']),
  }[key]();
  return `Connexion réussie · ${detail}`;
}

const bytes = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];

/** Espace disque lisible : 1,2 To. */
export function formatBytes(value: number): string {
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${bytes.format(n)} ${units[unit]}`;
}
