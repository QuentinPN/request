import type { ArrKind } from '@shared/arr-servers.ts';
import type { RequestNotificationKind } from '@shared/notifications.ts';
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
  | 'smtp'
  | 'trakt'
  | 'api'
  | 'blocklist'
  | 'general'
  | 'about';
export const settingsSectionOrder = [
  ...sectionOrder,
  'members',
  'webhooks',
  'seerr',
  'discord',
  'smtp',
  'trakt',
  'api',
  'blocklist',
  'general',
  'about',
] as const satisfies readonly SectionId[];

/** Évènements que Discord peut recevoir, dans l'ordre de la frise d'une demande (au nom du serveur multimédia choisi). */
export const discordEventLabels = (serverName: string): Record<RequestNotificationKind, string> => ({
  requested: 'Nouvelle demande à approuver',
  approved: 'Demande approuvée',
  declined: 'Demande refusée',
  available: `Titre disponible dans ${serverName}`,
  failed: 'Échec de l’envoi à Radarr ou Sonarr',
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
  members: { title: 'Membres', description: 'Déconnecter un membre de tous ses appareils' },
  webhooks: { title: 'Webhooks', description: 'Radarr et Sonarr préviennent l’appli dès qu’un titre arrive' },
  seerr: { title: 'Importer depuis Seerr', description: 'Reprendre une fois les demandes de Jellyseerr ou Overseerr' },
  discord: { title: 'Notifications Discord', description: 'Facultatif : les évènements des demandes dans un salon' },
  smtp: { title: 'Notifications par courriel', description: 'Facultatif : serveur SMTP pour écrire aux membres' },
  trakt: { title: 'Listes externes', description: 'Facultatif : import des listes de souhaits Trakt des membres' },
  api: { title: 'API', description: 'Clés pour les scripts et outils externes (en-tête X-Api-Key)' },
  blocklist: { title: 'Blocages', description: 'Titres et mots-clés TMDB qui ne peuvent pas être demandés' },
  general: { title: 'Général', description: 'Titre de l’application, affiché dans l’onglet et les messages' },
  about: { title: 'À propos', description: 'Version, environnement et compteurs, en lecture seule' },
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
