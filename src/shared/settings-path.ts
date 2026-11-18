/** Réglages du propriétaire : `/api/settings/<nom>` (sections de l'assistant, courriel, Discord, Trakt, clés…). */
export const SETTINGS_PATH = '/api/settings';
export const settingsPathOf = (name: string) => `${SETTINGS_PATH}/${name}`;
