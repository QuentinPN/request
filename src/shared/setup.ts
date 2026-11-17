import { z } from 'zod';
import { type IntegrationKey, integrationKeys, type SettingKey } from './settings.ts';

/** Les cinq sections de l'assistant, dans l'ordre de la page. */
export const setupSections = [...integrationKeys, 'rules'] as const satisfies readonly SettingKey[];
export type SetupSection = (typeof setupSections)[number];
export const setupSectionSchema = z.enum(setupSections);
export const integrationKeySchema = z.enum(integrationKeys as [IntegrationKey, ...IntegrationKey[]]);

export interface SetupState {
  /** Section enregistrée au moins une fois. */
  services: Record<SetupSection, boolean>;
  /** Un propriétaire existe : l'amorçage public d'Emby est fermé. */
  hasOwner: boolean;
  /** Toutes les sections enregistrées et un propriétaire désigné. */
  complete: boolean;
}

export interface EmbyLibrary {
  id: string;
  name: string;
  type: 'movies' | 'tvshows' | 'other';
}

export interface EmbyTestResult {
  serverName: string;
  version: string;
  serverId: string;
  libraries: EmbyLibrary[];
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
  emby: EmbyTestResult;
  tmdb: { ok: true };
  radarr: ArrTestResult;
  sonarr: SonarrTestResult;
}
