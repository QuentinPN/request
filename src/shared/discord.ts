import { agentSettingsPath, agentTestPath } from './agents.ts';

/** Réglages Discord (propriétaire seulement) : lecture, enregistrement, et message de test (`POST …/test`). */
export const DISCORD_SETTINGS_PATH = agentSettingsPath('discord');
export const DISCORD_TEST_PATH = agentTestPath('discord');
