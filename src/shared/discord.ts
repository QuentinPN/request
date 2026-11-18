import { settingsPathOf } from './settings-path.ts';

/** Réglages Discord (propriétaire seulement) : lecture, enregistrement, et message de test (`POST …/test`). */
export const DISCORD_SETTINGS_PATH = settingsPathOf('discord');
export const DISCORD_TEST_PATH = `${DISCORD_SETTINGS_PATH}/test`;
