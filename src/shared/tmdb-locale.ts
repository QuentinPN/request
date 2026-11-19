import { z } from 'zod';
import { settingsPathOf } from './settings-path.ts';

/** Langues de TMDB proposées (titres, synopsis, bande-annonce) : `fr-FR` par défaut. L'interface reste en français. */
export const TMDB_LANGUAGES = [
  'fr-FR',
  'fr-CA',
  'en-US',
  'en-GB',
  'es-ES',
  'de-DE',
  'it-IT',
  'pt-BR',
  'ja-JP',
] as const;
export type TmdbLanguage = (typeof TMDB_LANGUAGES)[number];
export const DEFAULT_TMDB_LANGUAGE: TmdbLanguage = 'fr-FR';

/** Régions de TMDB proposées (prochaines sorties, dates de sortie, plateformes de streaming) : `FR` par défaut. */
export const TMDB_REGIONS = ['FR', 'BE', 'CA', 'CH', 'LU', 'GB', 'US', 'ES', 'DE', 'IT', 'PT', 'BR', 'JP'] as const;
export type TmdbRegion = (typeof TMDB_REGIONS)[number];
export const DEFAULT_TMDB_REGION: TmdbRegion = 'FR';

export const tmdbLanguageLabels: Record<TmdbLanguage, string> = {
  'fr-FR': 'Français (France)',
  'fr-CA': 'Français (Canada)',
  'en-US': 'Anglais (États-Unis)',
  'en-GB': 'Anglais (Royaume-Uni)',
  'es-ES': 'Espagnol (Espagne)',
  'de-DE': 'Allemand (Allemagne)',
  'it-IT': 'Italien (Italie)',
  'pt-BR': 'Portugais (Brésil)',
  'ja-JP': 'Japonais (Japon)',
};

export const tmdbRegionLabels: Record<TmdbRegion, string> = {
  FR: 'France',
  BE: 'Belgique',
  CA: 'Canada',
  CH: 'Suisse',
  LU: 'Luxembourg',
  GB: 'Royaume-Uni',
  US: 'États-Unis',
  ES: 'Espagne',
  DE: 'Allemagne',
  IT: 'Italie',
  PT: 'Portugal',
  BR: 'Brésil',
  JP: 'Japon',
};

/** Code de langue seul d'une langue TMDB : `fr-CA` → `fr` (langue des bandes-annonces, `iso_639_1`). */
export const languageCodeOf = (language: TmdbLanguage): string => language.slice(0, 2);

/** Langue et région de TMDB, appliquées à tout le catalogue (réglage `tmdbLocale`, propriétaire). */
export const tmdbLocaleSchema = z.object({
  language: z.enum(TMDB_LANGUAGES).default(DEFAULT_TMDB_LANGUAGE),
  region: z.enum(TMDB_REGIONS).default(DEFAULT_TMDB_REGION),
});

export const TMDB_LOCALE_PATH = settingsPathOf('tmdb-locale');
