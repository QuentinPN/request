import type { FastifyBaseLogger } from 'fastify';

let appLog: FastifyBaseLogger | null = null;

/** Logger de l'application (posé au démarrage par `buildApp`) : les erreurs hors requête y arrivent, donc dans Journaux. */
export const setAppLog = (log: FastifyBaseLogger) => {
  appLog = log;
};

/** Journalise un échec d'arrière-plan ; sans logger posé, repli sur la console. `detail` : erreur ou texte déjà sûr. */
export function logError(message: string, detail?: unknown) {
  if (!appLog) return console.error(message, detail);
  appLog.error(detail instanceof Error ? { err: detail } : { detail }, message);
}
