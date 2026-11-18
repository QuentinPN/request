import { z } from 'zod';
import { arrKinds } from './arr-servers.ts';
import { type IntegrationKey, integrationKeys, type MediaServerKind, type SettingKey } from './settings.ts';
import { settingsPathOf } from './settings-path.ts';

/** Sections de l'assistant enregistrées comme réglages (`/api/settings/:service`). */
export const settingSections = [...integrationKeys, 'rules'] as const satisfies readonly SettingKey[];
export type SettingSection = (typeof settingSections)[number];
export const settingSectionSchema = z.enum(settingSections);

/**
 * Les cinq sections de l'assistant, dans l'ordre de la page. Radarr et Sonarr sont des serveurs (`arr_servers`) : leur
 * section est faite dès qu'un serveur du type existe.
 */
export const setupSections = [...integrationKeys, ...arrKinds, 'rules'] as const;
export type SetupSection = (typeof setupSections)[number];
export const integrationKeySchema = z.enum(integrationKeys as [IntegrationKey, ...IntegrationKey[]]);

export const SETUP_STATE_PATH = '/api/setup/state';
/** Réglage d'une section de l'assistant. */
export const settingPath = (key: SettingSection | ':service') => settingsPathOf(key);
export const setupTestPath = (key: IntegrationKey | ':service') => `/api/setup/${key}/test`;

export interface SetupState {
  /** Section enregistrée au moins une fois. */
  services: Record<SetupSection, boolean>;
  /**
   * Serveur multimédia choisi (Emby, Jellyfin ou Plex), `null` tant qu'aucun n'est enregistré. Public : l'écran de
   * connexion s'y adapte (identifiants ou bouton Plex) avant toute session.
   */
  mediaServerKind: MediaServerKind | null;
  /** Un propriétaire existe : l'amorçage public du serveur multimédia est fermé. */
  hasOwner: boolean;
  /** Toutes les sections enregistrées et un propriétaire désigné. */
  complete: boolean;
}

/** Bibliothèque d'un serveur multimédia (section Plex), classée films, séries ou autre. */
export interface MediaLibrary {
  id: string;
  name: string;
  type: 'movies' | 'tvshows' | 'other';
}

export interface MediaServerTestResult {
  serverName: string;
  version: string;
  serverId: string;
  libraries: MediaLibrary[];
}

export interface ArrTestResult {
  version: string;
  qualityProfiles: Array<{ id: number; name: string }>;
  rootFolders: Array<{ id: number; path: string; freeSpace: number }>;
}

export interface SonarrTestResult extends ArrTestResult {
  /** Présent uniquement en Sonarr v3 (supprimé en v4). */
  languageProfiles?: Array<{ id: number; name: string }>;
}

/** Réponse d'un test de connexion réussi, par service. */
export interface TestResults {
  mediaServer: MediaServerTestResult;
  tmdb: { ok: true };
  radarr: ArrTestResult;
  sonarr: SonarrTestResult;
}
