import { IntegrationError } from '../integrations/http.ts';
import { logError } from '../lib/logger.ts';

/**
 * Cause d'un échec, journalisable sans fuite : ni adresse (le jeton d'un webhook Discord est dans son chemin,
 * l'adresse d'un abonnement push désigne l'appareil), ni contenu. Code SMTP de nodemailer, statut HTTP sinon.
 */
function describeFailure(error: unknown): string {
  if (error instanceof IntegrationError) return `${error.kind}${error.status ? ` ${error.status}` : ''}`;
  if (error instanceof Error) {
    const { code, statusCode } = error as Error & { code?: unknown; statusCode?: unknown };
    if (typeof statusCode === 'number') return `HTTP ${statusCode}`;
    if (typeof code === 'string') return code;
  }
  return 'erreur inattendue';
}

/**
 * Envois des notifications (Discord, courriel, push) : planifiés pendant la transaction de l'évènement, exécutés après
 * sa validation (`setImmediate` : la transaction, synchrone, est alors terminée), sans attendre (la requête du membre
 * n'en dépend jamais) et sans nouvelle tentative. Un échec est journalisé, jamais levé, et n'arrête pas les autres
 * envois. Seule logique de ce genre : chaque canal s'en sert, aucun ne la recopie.
 */
export function createAfterCommit() {
  const pending = new Set<Promise<void>>();

  /** Planifie `work` après la transaction en cours (synchrone) ; ne lève jamais. `channel` nomme le canal du journal. */
  function schedule(channel: string, work: () => Promise<unknown>) {
    const task: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        await work();
      })
      .catch((error: unknown) => logError(`Notification ${channel} non envoyée`, describeFailure(error)))
      .finally(() => pending.delete(task));
    pending.add(task);
  }

  return {
    schedule,
    /** Résolu quand les envois planifiés, y compris ceux qu'ils planifient eux-mêmes, sont terminés (fermeture, tests). */
    async idle() {
      while (pending.size > 0) await Promise.all(pending);
    },
  };
}

export type AfterCommit = ReturnType<typeof createAfterCommit>;
