import type { IntegrationKey, minimumAvailabilities, seriesTypes } from '@shared/settings.ts';
import type { ArrTestResult, SetupSection, TestResults } from '@shared/setup.ts';

/** Ordre des sections à l'écran (DESIGN.md, maquette R-Assistant) : Emby, TMDB, Radarr, Sonarr, Règles. */
export const sectionOrder = ['emby', 'tmdb', 'radarr', 'sonarr', 'rules'] as const satisfies readonly SetupSection[];
// Toute section du contrat partagé doit apparaître ici.
const _complete: Exclude<SetupSection, (typeof sectionOrder)[number]> extends never ? true : never = true;
void _complete;

export const sectionText: Record<SetupSection, { title: string; description: string }> = {
  emby: { title: 'Emby', description: 'Connexion des membres et détection de ce qui est déjà là' },
  tmdb: { title: 'TMDB', description: 'Catalogue, affiches et tendances en français' },
  radarr: { title: 'Radarr', description: 'Films : profil de qualité et dossier racine' },
  sonarr: { title: 'Sonarr', description: 'Séries : profil de qualité, dossier racine et type' },
  rules: { title: 'Règles et quotas', description: 'Quotas de demandes par défaut des membres' },
};

/** Champs de connexion de chaque intégration ; `url: null` = clé seule (TMDB). */
export const connectionText: Record<
  IntegrationKey,
  { url: { placeholder: string } | null; apiKeyLabel: string; apiKeyHint: string }
> = {
  emby: {
    url: { placeholder: 'http://192.0.2.20:8096' },
    apiKeyLabel: 'Clé d’API',
    apiKeyHint: 'Emby › Tableau de bord › Avancé › Clés d’API',
  },
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

export const libraryTypeLabels = { movies: 'Films', tvshows: 'Séries', other: 'Autre' } as const;

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

const arrSummary = (name: string, r: ArrTestResult) =>
  `${name} v${r.version} · ${plural(r.qualityProfiles.length, 'profil')}, ${plural(r.rootFolders.length, 'dossier')}`;

/** Ligne affichée après un test réussi : « Connexion réussie · Sonarr v4.0.11 · 3 profils, 2 dossiers ». */
export function testSummary<K extends IntegrationKey>(key: K, result: TestResults[K]): string {
  const detail = {
    emby: () => {
      const r = result as TestResults['emby'];
      return `${r.serverName} · Emby v${r.version} · ${plural(r.libraries.length, 'bibliothèque')}`;
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
